import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { Observable, firstValueFrom, timer } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { EventStatus, PaymentStatus, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PaymentsService } from '../reservations/payments.service';
import { CONFIRM_QUEUE } from '../reservations/reservations.constants';
import { QueueService } from '../queue/queue.service';
import { QueueEventsService } from '../queue/queue-events.service';
import { EventsService } from '../events/events.service';

// 게이트 토큰 payload — 로그인 JWT(JwtPayload: sub/email/role)와 모양이 달라
// 서로 안 섞인다. type이 곧 "이 토큰의 용도" 표식.
export interface DemoGatePayload {
  type: 'demo';
}

// stats 대시보드 한 스냅샷의 모양(ADR 0016 축 B-2).
// paidCount/failedCount: 2026-08-06 PRD 재검토 — "관리자 판매 현황"이 이 공개
// stats 대시보드와 실질적으로 같다고 확인해 별도 화면 없이 여기 통합, 모의 결제
// (ADR 0018) 집계만 추가했다.
export interface DemoStats {
  // 게이지 시각화(2026-08-08)가 "재고 잔량 / 총량" 비율을 그리려면 분모(총량)가
  // 필요한데, DB의 진짜 값(inventory.totalQty)은 리셋해도 안 바뀌므로 매 틱
  // Redis에서 다시 읽을 필요 없이 streamStats() 시작 시 한 번만 조회해 흘려보낸다.
  totalQty: number;
  remainingQty: number; // 재고 잔량 — Redis 관문 카운터가 실시간 진실
  heldCount: number; // HELD 상태 예매 수량 합
  confirmedCount: number; // CONFIRMED 상태 예매 수량 합
  queueBacklog: number; // confirm 큐에 아직 안 끝난 job 수(대기+처리중)
  // 입장 대기열(ADR 0017)에서 아직 허가를 못 받고 대기 중인 인원 수 — queueBacklog와
  // 이름이 비슷하지만 완전히 다른 큐(BullMQ confirm 큐 vs Redis ZSet 입장 대기열)다.
  // 200명처럼 큰 배치를 투입하면 전원이 허가받기까지 시간이 걸리는데, 그 "아직
  // 대기 중"인 인원이 지금까진 전혀 안 보였다(2026-08-06 사용자 요청으로 추가).
  admissionQueueCount: number;
  paidCount: number; // 결제 성공(PAID) 건수
  failedCount: number; // 결제 실패(FAILED) 건수
  // 재고 소진으로 예매 자체가 막힌 시도 수(결제 단계 이전) — 결제 실패(failedCount)와
  // 다른 지표라 구분해서 보여준다(2026-08-06 실사용 중 "결제 실패가 왜 안 늘지?" 혼란에서 추가).
  soldOutCount: number;
  // 입장 허가를 받고도 예매 시도 자체를 안 하고 나간 가상 유저 수(ADR 0017 현실성
  // 요소) — 안 집계하면 "투입 인원수 = soldOut+paid+failed+held 합"이 안 맞아
  // 헷갈린다(2026-08-06 실사용 중 발견).
  abandonedCount: number;
  // 개별 예매를 티켓처럼 나열하기 위한 목록(2026-08-07) — 집계 숫자만으로는
  // "내가 방금 누른 버튼이 만든 결과"가 안 보인다는 피드백으로 추가.
  tickets: TicketSummary[];
}

// 티켓 카드/그리드 하나에 대응하는 최소 정보. isMine=true면 지금 보고 있는
// 방문자 본인의 실제 예매, false면 이 방문자가 투입한 가상 유저의 예매다
// (이벤트가 유저별로 격리돼 있어 다른 방문자의 예매는 애초에 안 섞인다).
export interface TicketSummary {
  id: number;
  quantity: number;
  status: ReservationStatus;
  paymentStatus: PaymentStatus | null;
  isMine: boolean;
}

/**
 * 공개 데모 모드(ADR 0016)의 데이터 리셋 + 진입 게이트.
 * - 리셋: seed와 수동 리셋 엔드포인트가 이 로직을 공유한다. 대상은 "이 유저가
 *   소유한" 데모 이벤트 하나뿐이다(2026-08-07, 유저별 격리 — ADR 0017 개정).
 *   예전엔 isDemo:true인 이벤트를 모든 방문자가 공유해서, 한 사람이 리셋하면
 *   동시에 테스트 중인 다른 사람 데이터까지 지워지는 문제가 있었다.
 * - 게이트: 공유 비번을 검증하고 단기 데모 토큰을 발급한다. 로그인과 완전히
 *   별개의 막이다(ADR: "게이트 ≠ 로그인").
 */
@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  // 투입 리듬(ADR 0016 2026-08-05 개정) — 묶음 발사. 묶음 안은 진짜 동시 요청이라
  // 경합이 재현되고, 묶음 사이 간격 덕분에 사람이 대시보드 숫자 변화를 따라갈 수 있다.
  private readonly SIM_BATCH_SIZE = 20;
  private readonly SIM_BATCH_INTERVAL_MS = 300;

  // auto=true(마운트 자동 투입) 전용 상한 — 이 인원수까지는 방문자 입장 전에
  // 무조건 대기열 입장을 동기로 마친다(2026-08-07). SIM_BATCH_SIZE(대시보드
  // 관찰용 발사 리듬)와는 목적이 달라 별도 상수로 둔다 — 프론트의 자동 투입
  // 규모(5~100명)가 전부 이 안에 들어오므로, 사실상 매번 크라우드 전원이
  // 방문자보다 먼저 대기열에 서게 된다.
  private readonly AUTO_JOIN_GUARANTEE_MAX = 100;

  // stats 대시보드 폴링 주기(축 B-2, ADR 0016 2026-08-05 결정 — 폴링 기반 스냅샷).
  private readonly STATS_POLL_INTERVAL_MS = 1000;

  // 재실행 쿨다운 잠금 키 — 유저별로 분리한다(2026-08-07, 유저별 격리) — 안
  // 그러면 한 사람의 쿨다운이 다른 사람의 시뮬레이션까지 막아버린다.
  private simCooldownKey(userId: number): string {
    return `demo:sim:cooldown:${userId}`;
  }
  // 이벤트 상세 페이지 마운트 시 자동 투입(booking-form.tsx, 2026-08-07)은 수동
  // "가상 유저 투입" 버튼과 별개의 훨씬 짧은 쿨다운을 쓴다 — 같은 키를 쓰면 방문자가
  // 뒤로 가기→재입장을 반복할 때마다 새 크라우드가 안 들어가 매번 대기열이 텅
  // 비어 보이는 문제가 있었다(사용자가 직접 재현해 발견). 수동 버튼은 최대
  // 300명까지 청할 수 있어 오남용 방지가 더 중요하므로 30초를 그대로 유지한다.
  private autoSimCooldownKey(userId: number): string {
    return `demo:sim:auto-cooldown:${userId}`;
  }

  // 시뮬레이션이 만드는 가상 유저 이메일의 식별 접두사 — 이벤트별로 스코프한다
  // (2026-08-07, 유저별 격리). 안 그러면 유저 A의 리셋이 `sim-` 접두사만 보고
  // 유저 B가 방금 투입한 가상 유저까지 지워버린다.
  private simUserEmailPrefix(eventId: number): string {
    return `sim-${eventId}-`;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reservations: ReservationsService,
    private readonly payments: PaymentsService,
    private readonly queueService: QueueService,
    private readonly queueEvents: QueueEventsService,
    private readonly eventsService: EventsService,
    @InjectQueue(CONFIRM_QUEUE) private readonly confirmQueue: Queue,
  ) {}

  // 가상 유저의 현실성(ADR 0017) — 입장 허가를 받아도 사람처럼 포기하거나
  // 늦게 시도할 수 있다. env로 뺀 이유는 순전히 테스트 속도(수 초~수십 초짜리
  // 실제 지연을 기다리지 않고 테스트에서 아주 작은 값으로 덮어쓸 수 있어야 함) —
  // 운영값 자체는 바뀔 일이 거의 없다.
  private abandonProbability(): number {
    return Number(this.config.get<string>('DEMO_SIM_ABANDON_PROBABILITY') ?? 0.2);
  }
  // 입장 허가창(QUEUE_ADMISSION_WINDOW_MS, 기본 8초)보다 살짝 넓게 잡아야 "대부분
  // 성공, 느린 일부만 놓침"이 된다 — 창보다 훨씬 넓으면(예전 1~35초) 대부분이
  // 허가창을 놓쳐 반대로 "대부분 실패"가 된다(실측: 8초 창+1~35초 지연 → 30명 중
  // 5명만 성공. 근본 원인은 버그가 아니라 두 값의 비율 — 2026-08-06 e2e에서 발견).
  private minBookingDelayMs(): number {
    return Number(this.config.get<string>('DEMO_SIM_MIN_BOOKING_DELAY_MS') ?? 500);
  }
  private maxBookingDelayMs(): number {
    return Number(this.config.get<string>('DEMO_SIM_MAX_BOOKING_DELAY_MS') ?? 10000);
  }

  async enterGate(password: string): Promise<{ demoToken: string }> {
    const expected = this.config.get<string>('DEMO_GATE_PASSWORD');
    if (!expected || password !== expected) {
      throw new UnauthorizedException('비밀번호가 올바르지 않습니다.');
    }
    const payload: DemoGatePayload = { type: 'demo' };
    const demoToken = await this.jwt.signAsync(payload);
    return { demoToken };
  }

  async resetDemoEvent(userId: number) {
    const event = await this.eventsService.findOrCreateOwnDemoEvent(userId);
    if (!event.inventory) {
      throw new NotFoundException(
        '데모 이벤트가 없습니다 — seed(prisma db seed)를 먼저 실행하세요.',
      );
    }

    // Payment→Reservation FK(ADR 0018) 때문에 예매보다 결제를 먼저 지워야 한다
    // (안 그러면 P2003 위반 — 결제 기록이 하나라도 있으면 리셋이 그대로 500으로 죽었다).
    await this.prisma.payment.deleteMany({ where: { reservation: { eventId: event.id } } });
    // 예매를 지워야 재고가 실제로 원복된다(HELD/CONFIRMED가 남아있으면 재구성
    // 잡(reconcile)이 다음 틱에 다시 깎아버림 — 순서가 아니라 삭제 자체가 핵심).
    await this.prisma.reservation.deleteMany({ where: { eventId: event.id } });

    // 시뮬레이션이 만든 가상 유저 정리(ADR 0016 2026-08-05 개정) — 안 지우면
    // 리셋을 반복할 때마다 무료 티어 DB에 계정이 계속 쌓인다. 예매를 먼저
    // 지웠으니 FK 걱정 없이 바로 지울 수 있다. 이벤트별로 스코프된 접두사라
    // 다른 유저가 방금 투입한 가상 유저는 안 건드린다(2026-08-07 유저별 격리).
    await this.prisma.user.deleteMany({
      where: { email: { startsWith: this.simUserEmailPrefix(event.id) } },
    });

    const inventory = await this.prisma.inventory.update({
      where: { eventId: event.id },
      data: {
        remainingQty: event.inventory.totalQty,
        version: { increment: 1 }, // 낙관적 락(W2) 전략과의 충돌 방지
      },
    });

    await this.redis.set(`stock:event:${event.id}`, inventory.remainingQty);
    await this.redis.set(`soldout:event:${event.id}`, 0);
    await this.redis.set(`abandoned:event:${event.id}`, 0);

    // 대기열도 함께 비운다(ADR 0017 연동, 2026-08-06 실사용 중 발견) — 안 지우면
    // 리셋 전에 대기열에 남아있던 사람들이 리셋 후에도 계속 입장 허가를 받아
    // 방금 원복한 재고를 또 깎는다. 이미 허가를 받고 랜덤 지연 중인 사람은
    // admitted 키의 짧은 TTL(기본 8초)이 지나면 자연히 막히므로 별도 처리 없음.
    await this.queueService.purge(event.id);

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
   *
   * auto=true(이벤트 상세 페이지 마운트 시 자동 투입, 2026-08-07)일 때는
   * 최대 AUTO_JOIN_GUARANTEE_MAX명까지 대기열 입장이 끝날 때까지 기다렸다가
   * 응답한다 — 호출부(booking-form.tsx)가 이 응답을 받은 뒤에야 방문자 본인을
   * 대기열에 넣으므로, 응답이 그 전에 오면 방문자가 항상 0번을 받는 순서
   * 문제가 있었다.
   */
  async simulateLoad(
    virtualUserCount: number,
    userId: number,
    auto = false,
  ): Promise<{ accepted: number }> {
    const maxVu = Number(this.config.get<string>('DEMO_SIM_MAX_VU') ?? 300);
    if (virtualUserCount > maxVu) {
      throw new BadRequestException(
        `가상 유저 수는 최대 ${maxVu}명까지 가능합니다.`,
      );
    }

    // NX(키 없을 때만 SET) + PX(밀리초 TTL) — "쿨다운 중인지 확인 후 잠근다"가
    // 아니라 이 SET 자체가 원자적 확인+잠금이다(둘로 나누면 그 틈에 경합 가능).
    // auto(페이지 마운트 자동 투입)는 별도 키+훨씬 짧은 쿨다운을 쓴다(위 주석 참고).
    // 유저별로 분리된 키라(2026-08-07) 다른 유저의 쿨다운엔 영향이 없다.
    const cooldownKey = auto ? this.autoSimCooldownKey(userId) : this.simCooldownKey(userId);
    const cooldownMs = auto
      ? Number(this.config.get<string>('DEMO_SIM_AUTO_COOLDOWN_MS') ?? 3000)
      : Number(this.config.get<string>('DEMO_SIM_COOLDOWN_MS') ?? 30000);
    const acquired = await this.redis.set(
      cooldownKey,
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

    const event = await this.eventsService.findOrCreateOwnDemoEvent(userId);

    if (auto) {
      // 방문자 본인이 대기열에 합류하기 전에 최대 AUTO_JOIN_GUARANTEE_MAX명
      // 만큼은 실제로 대기열 입장까지 마쳐야 한다 — 안 그러면 방문자의 단순 ZADD
      // 한 번이 가상 유저의 "User 생성 후 ZADD"보다 항상 먼저 끝나버려
      // 크라우드 규모와 무관하게 항상 0번을 받는다(2026-08-07 실사용 중 발견,
      // 프론트도 이 응답을 받은 뒤에야 본인 입장을 호출하도록 짝을 맞췄다).
      // 나머지 인원은 기존처럼 백그라운드로 이어간다.
      const firstBatchSize = Math.min(this.AUTO_JOIN_GUARANTEE_MAX, virtualUserCount);
      await Promise.all(
        Array.from({ length: firstBatchSize }, () =>
          this.injectVirtualUser(event.id),
        ),
      );
      const remaining = virtualUserCount - firstBatchSize;
      if (remaining > 0) {
        void this.runSimulationBatches(event.id, remaining).catch((e) => {
          this.logger.error('시뮬레이션 배치 처리 중 오류', e);
        });
      }
    } else {
      // 컨트롤러 응답을 기다리게 하지 않는다(fire-and-forget) — 실패는 로그로만 남긴다.
      void this.runSimulationBatches(event.id, virtualUserCount).catch((e) => {
        this.logger.error('시뮬레이션 배치 처리 중 오류', e);
      });
    }

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

  // 가상 유저 한 명 = 실제 User 레코드 생성 + 대기열 진입. 실제 예매 시도는
  // 대기열 입장 허가를 받은 뒤 별도로(fire-and-forget) 이어진다(ADR 0017) —
  // 그래야 배치 발사 리듬(0016)이 입장 처리 리듬(ADR 0017)을 기다리지 않는다.
  private async injectVirtualUser(eventId: number) {
    try {
      const user = await this.prisma.user.create({
        data: {
          email: `${this.simUserEmailPrefix(eventId)}${randomUUID()}@sunchak.demo`,
          password: null,
        },
      });
      await this.queueService.join(eventId, user.id);
      void this.simulateBookingAttempt(eventId, user.id).catch((e) => {
        this.logger.error('가상 유저 예매 시도 중 오류', e);
      });
    } catch (e) {
      this.logger.error('가상 유저 생성/대기열 진입 실패', e);
    }
  }

  // 입장 허가를 기다렸다가, 실제 사람처럼 확률적으로 포기하거나 랜덤 지연 후
  // 예매를 시도한다. 지연이 입장 허가창을 넘기면 실사용자와 똑같이
  // assertAdmitted에서 막힌다 — 가상 유저를 위한 특수 경로는 없다.
  // 포기(허가창 만료 포함)와 재고 소진은 이 데모가 보여주려는 정상 시나리오라
  // 조용히 넘어간다 — 그 외 예외만 로그를 남긴다. 다만 "조용히"가 "집계 안 함"을
  // 뜻하진 않는다 — 둘 다 abandoned/soldout 카운터로 남겨야 "투입 인원수 =
  // paid+failed+soldOut+abandoned 합"이 실제로 맞는다(2026-08-06 실사용 중
  // 사용자가 이 등식이 안 맞는 걸 직접 발견해 추가).
  //
  // ⚠️ 결제(ADR 0018)까지 이어서 호출한다 — 안 그러면 가상 유저는 전부 HELD에서
  // 멈추고 CONFIRMED/CANCELLED로 못 넘어간다(2026-08-06 실사용 중 발견한 버그:
  // 결제 단계 도입 당시 이 메서드를 안 고쳐서, HELD 이후 아무도 "결제"를 안 해
  // PAID/FAILED 집계가 항상 0으로 보였다).
  private async simulateBookingAttempt(eventId: number, userId: number) {
    await firstValueFrom(this.queueEvents.ofUser(eventId, userId));

    if (Math.random() < this.abandonProbability()) {
      // 허가를 받고도 시도하지 않고 나감 — 예매를 아예 안 하니 재고소진 실패처럼
      // 별도로 집계해두지 않으면 "투입 인원수와 스탯 합계가 안 맞는다"는 혼란이
      // 생긴다(2026-08-06 실사용 중 발견).
      await this.redis.incr(`abandoned:event:${eventId}`);
      return;
    }

    const min = this.minBookingDelayMs();
    const max = this.maxBookingDelayMs();
    const delay = min + Math.random() * (max - min);
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.queueService.assertAdmitted(eventId, userId);
      const reservation = await this.reservations.create(
        eventId,
        userId,
        1,
        'held',
        randomUUID(),
      );
      await this.payments.pay(reservation.id, userId, randomUUID());
    } catch (e) {
      if (e instanceof ForbiddenException) {
        // 랜덤 지연(최대 10초)이 입장 허가창(기본 8초)보다 길 수 있어, 그 사이
        // 허가가 자연 만료된 경우다 — 확률적 포기와 결과가 같으므로(둘 다
        // "예매를 시도 못 하고 나감") 같은 카운터에 묶는다.
        await this.redis.incr(`abandoned:event:${eventId}`);
        return;
      }
      if (e instanceof ConflictException) {
        return; // soldout 카운터는 이미 createHeld() 안에서 증가시켰다.
      }
      throw e;
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
  async streamStats(userId: number): Promise<Observable<MessageEvent>> {
    const event = await this.eventsService.findOrCreateOwnDemoEvent(userId);
    if (!event.inventory) {
      throw new NotFoundException('데모 이벤트의 재고를 찾을 수 없습니다.');
    }
    const eventId = event.id;
    const totalQty = event.inventory.totalQty;

    // timer(0, 주기): 구독 즉시 한 번 쏘고, 그 다음부터 주기마다 반복.
    return timer(0, this.STATS_POLL_INTERVAL_MS).pipe(
      switchMap(() => this.getStats(eventId, userId, totalQty)),
      map((stats) => ({ data: stats }) as MessageEvent),
    );
  }

  private async getStats(
    eventId: number,
    ownerId: number,
    totalQty: number,
  ): Promise<DemoStats> {
    const [remaining, statusSums, waiting, active, paymentCounts, soldOut, abandoned, queued, tickets] =
      await Promise.all([
        this.redis.get(`stock:event:${eventId}`),
        this.prisma.reservation.groupBy({
          by: ['status'],
          where: { eventId },
          _sum: { quantity: true },
        }),
        this.confirmQueue.getWaitingCount(),
        this.confirmQueue.getActiveCount(),
        this.prisma.payment.groupBy({
          by: ['status'],
          where: { reservation: { eventId } },
          _count: { _all: true },
        }),
        this.redis.get(`soldout:event:${eventId}`),
        this.redis.get(`abandoned:event:${eventId}`),
        this.queueService.size(eventId),
        // 개별 예매를 티켓 카드/그리드로 보여주기 위한 목록(2026-08-07) — 집계
        // 숫자만으로는 "내가 방금 누른 버튼이 만든 결과"가 안 보인다는 피드백.
        this.prisma.reservation.findMany({
          where: { eventId },
          select: {
            id: true,
            userId: true,
            quantity: true,
            status: true,
            payment: { select: { status: true } },
          },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

    const sumOf = (status: ReservationStatus) =>
      statusSums.find((s) => s.status === status)?._sum.quantity ?? 0;
    const countOf = (status: PaymentStatus) =>
      paymentCounts.find((p) => p.status === status)?._count._all ?? 0;

    return {
      totalQty,
      remainingQty: Number(remaining ?? 0),
      heldCount: sumOf(ReservationStatus.HELD),
      confirmedCount: sumOf(ReservationStatus.CONFIRMED),
      queueBacklog: waiting + active,
      paidCount: countOf(PaymentStatus.PAID),
      failedCount: countOf(PaymentStatus.FAILED),
      soldOutCount: Number(soldOut ?? 0),
      // 이벤트가 유저별로 격리돼(2026-08-07) 여기 보이는 예매는 항상 "내 실제
      // 예매 1건 이하 + 내가 투입한 가상 유저들의 예매"뿐이다 — 다른 방문자
      // 데이터가 섞일 걱정 없이 그대로 리스트로 노출해도 된다.
      tickets: tickets.map((t) => ({
        id: t.id,
        quantity: t.quantity,
        status: t.status,
        paymentStatus: t.payment?.status ?? null,
        isMine: t.userId === ownerId,
      })),
      abandonedCount: Number(abandoned ?? 0),
      admissionQueueCount: queued,
    };
  }
}
