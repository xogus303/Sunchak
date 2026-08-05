import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  MessageEvent,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Observable, timer } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { EventStatus, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ReservationsService } from '../reservations/reservations.service';
import { CONFIRM_QUEUE } from '../reservations/reservations.constants';

// 게이트 토큰 payload — 로그인 JWT(JwtPayload: sub/email/role)와 모양이 달라
// 서로 안 섞인다. type이 곧 "이 토큰의 용도" 표식.
export interface DemoGatePayload {
  type: 'demo';
}

// stats 대시보드 한 스냅샷의 모양(ADR 0016 축 B-2).
export interface DemoStats {
  remainingQty: number; // 재고 잔량 — Redis 관문 카운터가 실시간 진실
  heldCount: number; // HELD 상태 예매 수량 합
  confirmedCount: number; // CONFIRMED 상태 예매 수량 합
  queueBacklog: number; // confirm 큐에 아직 안 끝난 job 수(대기+처리중)
}

/**
 * 공개 데모 모드(ADR 0016)의 데이터 리셋 + 진입 게이트.
 * - 리셋: seed와 수동 리셋 엔드포인트가 이 로직을 공유한다. 대상은
 *   `isDemo=true`인 단 하나의 이벤트뿐이다(로컬의 다른 이벤트와 안 섞이게).
 * - 게이트: 공유 비번을 검증하고 단기 데모 토큰을 발급한다. 로그인과 완전히
 *   별개의 막이다(ADR: "게이트 ≠ 로그인").
 */
@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  // 시뮬레이션이 만드는 가상 유저 이메일의 식별 접두사. §C 리셋이 이 패턴으로
  // 골라 지운다(스키마 변경 없이 isDemo 식별 취지를 재사용, ADR 0016 2026-08-05 개정).
  private readonly SIM_USER_EMAIL_PREFIX = 'sim-';

  // 투입 리듬(ADR 0016 2026-08-05 개정) — 묶음 발사. 묶음 안은 진짜 동시 요청이라
  // 경합이 재현되고, 묶음 사이 간격 덕분에 사람이 대시보드 숫자 변화를 따라갈 수 있다.
  private readonly SIM_BATCH_SIZE = 20;
  private readonly SIM_BATCH_INTERVAL_MS = 300;

  // 재실행 쿨다운 잠금 키(전역 스코프 — 게이트 통과자라면 누구든 공유).
  private readonly SIM_COOLDOWN_KEY = 'demo:sim:cooldown';

  // stats 대시보드 폴링 주기(축 B-2, ADR 0016 2026-08-05 결정 — 폴링 기반 스냅샷).
  private readonly STATS_POLL_INTERVAL_MS = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reservations: ReservationsService,
    @InjectQueue(CONFIRM_QUEUE) private readonly confirmQueue: Queue,
  ) {}

  async enterGate(password: string): Promise<{ demoToken: string }> {
    const expected = this.config.get<string>('DEMO_GATE_PASSWORD');
    if (!expected || password !== expected) {
      throw new UnauthorizedException('비밀번호가 올바르지 않습니다.');
    }
    const payload: DemoGatePayload = { type: 'demo' };
    const demoToken = await this.jwt.signAsync(payload);
    return { demoToken };
  }

  async resetDemoEvent() {
    const event = await this.prisma.event.findFirst({
      where: { isDemo: true },
      include: { inventory: true },
    });
    if (!event || !event.inventory) {
      throw new NotFoundException(
        '데모 이벤트가 없습니다 — seed(prisma db seed)를 먼저 실행하세요.',
      );
    }

    // 예매를 지워야 재고가 실제로 원복된다(HELD/CONFIRMED가 남아있으면 재구성
    // 잡(reconcile)이 다음 틱에 다시 깎아버림 — 순서가 아니라 삭제 자체가 핵심).
    await this.prisma.reservation.deleteMany({ where: { eventId: event.id } });

    // 시뮬레이션이 만든 가상 유저 정리(ADR 0016 2026-08-05 개정) — 안 지우면
    // 리셋을 반복할 때마다 무료 티어 DB에 계정이 계속 쌓인다. 예매를 먼저
    // 지웠으니 FK 걱정 없이 바로 지울 수 있다.
    await this.prisma.user.deleteMany({
      where: { email: { startsWith: this.SIM_USER_EMAIL_PREFIX } },
    });

    const inventory = await this.prisma.inventory.update({
      where: { eventId: event.id },
      data: {
        remainingQty: event.inventory.totalQty,
        version: { increment: 1 }, // 낙관적 락(W2) 전략과의 충돌 방지
      },
    });

    await this.redis.set(`stock:event:${event.id}`, inventory.remainingQty);

    const updatedEvent = await this.prisma.event.update({
      where: { id: event.id },
      data: { openAt: new Date(), status: EventStatus.ON_SALE },
    });

    return { event: updatedEvent, inventory };
  }

  /**
   * 서버측 부하 시뮬레이션 진입점(ADR 0016 축 B-1). 가상 유저 N명을 실제
   * 파이프라인(관문→HELD→큐→확정)에 흘려보낸다. 상한·쿨다운을 통과시킨 뒤
   * 즉시 반환하고(202), 실제 투입은 백그라운드에서 진행한다 — 진행 상황은
   * 방문자가 축 B-2 SSE stats 스트림으로 지켜본다.
   */
  async simulateLoad(virtualUserCount: number): Promise<{ accepted: number }> {
    const maxVu = Number(this.config.get<string>('DEMO_SIM_MAX_VU') ?? 300);
    if (virtualUserCount > maxVu) {
      throw new BadRequestException(
        `가상 유저 수는 최대 ${maxVu}명까지 가능합니다.`,
      );
    }

    // NX(키 없을 때만 SET) + PX(밀리초 TTL) — "쿨다운 중인지 확인 후 잠근다"가
    // 아니라 이 SET 자체가 원자적 확인+잠금이다(둘로 나누면 그 틈에 경합 가능).
    const cooldownMs = Number(
      this.config.get<string>('DEMO_SIM_COOLDOWN_MS') ?? 30000,
    );
    const acquired = await this.redis.set(
      this.SIM_COOLDOWN_KEY,
      '1',
      'PX',
      cooldownMs,
      'NX',
    );
    if (!acquired) {
      throw new HttpException(
        '쿨다운 중입니다. 잠시 후 다시 시도하세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const event = await this.prisma.event.findFirst({ where: { isDemo: true } });
    if (!event) {
      throw new NotFoundException(
        '데모 이벤트가 없습니다 — seed(prisma db seed)를 먼저 실행하세요.',
      );
    }

    // 컨트롤러 응답을 기다리게 하지 않는다(fire-and-forget) — 실패는 로그로만 남긴다.
    void this.runSimulationBatches(event.id, virtualUserCount).catch((e) => {
      this.logger.error('시뮬레이션 배치 처리 중 오류', e);
    });

    return { accepted: virtualUserCount };
  }

  private async runSimulationBatches(eventId: number, count: number) {
    let remaining = count;
    while (remaining > 0) {
      const batchSize = Math.min(this.SIM_BATCH_SIZE, remaining);
      await Promise.all(
        Array.from({ length: batchSize }, () =>
          this.injectVirtualUser(eventId),
        ),
      );
      remaining -= batchSize;
      if (remaining > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.SIM_BATCH_INTERVAL_MS),
        );
      }
    }
    this.logger.log(`시뮬레이션 완료: 이벤트 ${eventId}, 가상 유저 ${count}명 투입`);
  }

  // 가상 유저 한 명 = 실제 User 레코드 생성 + held 전략으로 예매 1건 시도.
  // 재고 소진(ConflictException)은 이 데모가 보여주려는 정상 시나리오이므로
  // 조용히 넘어간다 — 그 외 예외만 로그를 남긴다(개별 실패가 나머지 배치를 막지 않게).
  private async injectVirtualUser(eventId: number) {
    try {
      const user = await this.prisma.user.create({
        data: {
          email: `${this.SIM_USER_EMAIL_PREFIX}${randomUUID()}@sunchak.demo`,
          password: null,
        },
      });
      await this.reservations.create(
        eventId,
        user.id,
        1,
        'held',
        randomUUID(),
      );
    } catch (e) {
      if (e instanceof ConflictException) {
        return;
      }
      this.logger.error('가상 유저 예매 실패', e);
    }
  }

  /**
   * 실시간 판매 대시보드(ADR 0016 축 B-2). W3 2.4의 @Sse+이벤트 버스와 달리
   * 소스가 3개(Redis 재고·DB 상태별 합계·BullMQ 큐 적체)라 이벤트 기반으로
   * 엮으면 기존 파이프라인 여러 곳을 건드려야 해서, 대신 짧은 주기로 "지금
   * 상태"를 다시 조회해 흘리는 폴링 기반 스냅샷을 택했다(기존 코드 무변경).
   *
   * 데모 이벤트 존재 확인은 구독 시작 전 한 번만(이후 매 틱마다 이벤트를
   * 다시 찾을 필요 없음 — 리셋은 같은 이벤트 행을 갱신할 뿐 id가 안 바뀐다).
   */
  async streamStats(): Promise<Observable<MessageEvent>> {
    const event = await this.prisma.event.findFirst({ where: { isDemo: true } });
    if (!event) {
      throw new NotFoundException(
        '데모 이벤트가 없습니다 — seed(prisma db seed)를 먼저 실행하세요.',
      );
    }
    const eventId = event.id;

    // timer(0, 주기): 구독 즉시 한 번 쏘고, 그 다음부터 주기마다 반복.
    return timer(0, this.STATS_POLL_INTERVAL_MS).pipe(
      switchMap(() => this.getStats(eventId)),
      map((stats) => ({ data: stats }) as MessageEvent),
    );
  }

  private async getStats(eventId: number): Promise<DemoStats> {
    const [remaining, statusSums, waiting, active] = await Promise.all([
      this.redis.get(`stock:event:${eventId}`),
      this.prisma.reservation.groupBy({
        by: ['status'],
        where: { eventId },
        _sum: { quantity: true },
      }),
      this.confirmQueue.getWaitingCount(),
      this.confirmQueue.getActiveCount(),
    ]);

    const sumOf = (status: ReservationStatus) =>
      statusSums.find((s) => s.status === status)?._sum.quantity ?? 0;

    return {
      remainingQty: Number(remaining ?? 0),
      heldCount: sumOf(ReservationStatus.HELD),
      confirmedCount: sumOf(ReservationStatus.CONFIRMED),
      queueBacklog: waiting + active,
    };
  }
}
