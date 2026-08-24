import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { QueueEventsService } from '../queue/queue-events.service';
import { EventsService } from '../events/events.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PaymentsService } from '../reservations/payments.service';

// 리셋 없이 첫 simulate 호출로 이벤트가 자동 생성될 때의 기본 재고 — 캐주얼
// 데모(findOrCreateOwnDemoEvent의 100)처럼 env로 뺄 만큼 운영 중 바뀔 값이
// 아니라 그냥 상수로 둔다.
const DEFAULT_STOCK = 1_000;

/**
 * 대용량 트래픽 테스트(ADR 0016 백로그) — 캐주얼 데모(DemoService)와 완전히
 * 분리된 별도 경로. 유저가 재고·투입 인원을 직접 정해 시작한다(1:1,
 * Event.loadTestOwnerId).
 *
 * 게이트(쿨다운·상한) → 이벤트 준비/리셋 → 가상 유저 투입까지 전부 구현한다.
 * 실제 인프라 부담의 실질 상한선은 쿨다운이 아니라 예매 시도 페이스
 * (SIM_BATCH_*, 2026-08-25 설계 논의)가 맡는다 — 입장 허가(poissonLikeBatchSize
 * 기반, LoadTestAdmissionProcessor)는 화면상 체감을 위해 크고 변동있게
 * 가져가되, Postgres에 실제로 꽂히는 예매 시도 자체는 이 페이스로 별도 제한된다.
 */
@Injectable()
export class LoadTestService {
  private readonly logger = new Logger(LoadTestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly eventsService: EventsService,
    private readonly queueService: QueueService,
    private readonly queueEvents: QueueEventsService,
    private readonly reservations: ReservationsService,
    private readonly payments: PaymentsService,
  ) {}

  // demo.service.ts의 DEMO_SIM_MAX_VU 등과 같은 이유로 env로 뺀다 — 배포 후
  // 재계산 없이 조정 가능해야 하고, 테스트에서 60초 쿨다운을 그대로 기다리지
  // 않도록 짧은 값으로 덮어쓸 수 있어야 한다.
  private cooldownMs(): number {
    return Number(this.config.get<string>('LOAD_TEST_COOLDOWN_MS') ?? 60_000);
  }
  private maxVu(): number {
    return Number(this.config.get<string>('LOAD_TEST_MAX_VU') ?? 10_000);
  }
  private maxStock(): number {
    return Number(this.config.get<string>('LOAD_TEST_MAX_STOCK') ?? 10_000);
  }

  // 실제 예매 시도(Postgres에 INSERT가 꽂히는 페이스) — 여기가 이 기능의
  // 진짜 안전장치다(2026-08-25 설계 논의: 입장 허가가 아무리 크고 빨라도,
  // 가상 유저가 "실제로 예매를 시도"하는 속도는 이 페이스로 상한이 그어져
  // 있어 Neon 부담이 커지지 않는다). 기본값 100명/500ms = 초당 200명 —
  // 로컬 벤치마크(Redis atomic 9,354 RPS)에 비해 충분히 보수적이다.
  private simBatchSize(): number {
    return Number(this.config.get<string>('LOAD_TEST_SIM_BATCH_SIZE') ?? 100);
  }
  private simBatchIntervalMs(): number {
    return Number(
      this.config.get<string>('LOAD_TEST_SIM_BATCH_INTERVAL_MS') ?? 500,
    );
  }

  // 가상 유저 현실성(ADR 0017) — 캐주얼 데모(DemoService)와 같은 현상(사람은
  // 입장 허가를 받아도 포기하거나 늦게 시도한다)이라 같은 env 키를 그대로
  // 재사용한다(값을 공유할 뿐 코드 의존은 없음 — LoadTestService는
  // DemoService를 참조하지 않는다).
  private abandonProbability(): number {
    return Number(this.config.get<string>('DEMO_SIM_ABANDON_PROBABILITY') ?? 0.2);
  }
  private minBookingDelayMs(): number {
    return Number(this.config.get<string>('DEMO_SIM_MIN_BOOKING_DELAY_MS') ?? 500);
  }
  private maxBookingDelayMs(): number {
    return Number(
      this.config.get<string>('DEMO_SIM_MAX_BOOKING_DELAY_MS') ?? 10_000,
    );
  }

  private cooldownKey(userId: number): string {
    return `loadtest:sim:cooldown:${userId}`;
  }

  // 리셋 시 가상 유저만 골라 지우기 위한 접두사 — 이벤트별로 스코프한다
  // (demo.service.ts의 simUserEmailPrefix와 같은 이유, 다른 접두사라 서로 안 섞임).
  private virtualUserEmailPrefix(eventId: number): string {
    return `loadtest-${eventId}-`;
  }

  async simulateLoad(
    virtualUserCount: number,
    userId: number,
  ): Promise<{ accepted: number }> {
    const maxVu = this.maxVu();
    if (virtualUserCount > maxVu) {
      throw new BadRequestException(
        `가상 유저 수는 최대 ${maxVu}명까지 가능합니다.`,
      );
    }

    // NX+PX가 "쿨다운 중인지 확인 후 잠근다"가 아니라 이 SET 자체가 원자적
    // 확인+잠금이다(demo.service.ts와 같은 이유로 경합 방지). 유저별 키라
    // 다른 유저의 쿨다운엔 영향이 없다.
    const acquired = await this.redis.set(
      this.cooldownKey(userId),
      '1',
      'PX',
      this.cooldownMs(),
      'NX',
    );
    if (!acquired) {
      throw new HttpException(
        '쿨다운 중입니다. 잠시 후 다시 시도하세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const event = await this.eventsService.findOrCreateOwnLoadTestEvent(
      userId,
      DEFAULT_STOCK,
    );

    // 컨트롤러 응답을 기다리게 하지 않는다(fire-and-forget, demo.service.ts와
    // 같은 이유) — 실패는 로그로만 남긴다.
    void this.runInjectionBatches(event.id, virtualUserCount).catch((e) => {
      this.logger.error('대용량 테스트 투입 배치 처리 중 오류', e);
    });

    return { accepted: virtualUserCount };
  }

  // 가상 유저를 simBatchSize()만큼씩 묶어 simBatchIntervalMs() 간격으로 흘려
  // 보낸다 — 입장 허가(LoadTestAdmissionProcessor)가 아무리 커도, 실제 예매
  // 시도(Postgres INSERT)는 이 페이스로 항상 제한된다.
  private async runInjectionBatches(eventId: number, count: number) {
    let remaining = count;
    while (remaining > 0) {
      const batchSize = Math.min(this.simBatchSize(), remaining);
      await Promise.all(
        Array.from({ length: batchSize }, () => this.injectVirtualUser(eventId)),
      );
      remaining -= batchSize;
      if (remaining > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.simBatchIntervalMs()),
        );
      }
    }
    this.logger.log(`대용량 테스트 투입 완료: 이벤트 ${eventId}, 가상 유저 ${count}명`);
  }

  // 가상 유저 한 명 = 실제 User 레코드 생성 + 대기열 진입(joinLoadTest, 캐주얼
  // 데모와 다른 활성 목록에 등록됨). 실제 예매 시도는 입장 허가를 받은 뒤
  // 별도로(fire-and-forget) 이어진다(demo.service.ts의 injectVirtualUser와
  // 같은 구조, 큐/이벤트만 대용량 전용).
  private async injectVirtualUser(eventId: number) {
    try {
      const user = await this.prisma.user.create({
        data: {
          email: `${this.virtualUserEmailPrefix(eventId)}${randomUUID()}@sunchak.demo`,
          password: null,
        },
      });
      await this.queueService.joinLoadTest(eventId, user.id);
      void this.simulateBookingAttempt(eventId, user.id).catch((e) => {
        this.logger.error('가상 유저 예매 시도 중 오류', e);
      });
    } catch (e) {
      this.logger.error('가상 유저 생성/대기열 진입 실패', e);
    }
  }

  // 입장 허가를 기다렸다가, 실제 사람처럼 확률적으로 포기하거나 랜덤 지연 후
  // 예매를 시도한다(demo.service.ts의 simulateBookingAttempt와 같은 구조).
  // 재고소진은 정상 시나리오라 조용히 넘어간다 — soldOut 카운터는 createHeld()
  // 안에서 이미 증가되므로(이벤트 종류와 무관하게 공유되는 로직) 여기서 따로
  // 손댈 필요 없다. 포기(확률적 + 허가창 만료)는 abandoned 카운터로 남긴다 —
  // 안 남기면 "투입 인원수 = paid+failed+soldOut+abandoned 합"이 안 맞아
  // 나중에 관측 화면을 붙일 때 숫자가 설명 안 되는 유령 인원이 생긴다
  // (2026-08-06 캐주얼 데모에서 실사용 중 겪은 것과 같은 함정 — 실서버 e2e로
  // 이 메서드를 처음 검증할 때 동일하게 재현해 발견).
  private async simulateBookingAttempt(eventId: number, userId: number) {
    await firstValueFrom(this.queueEvents.ofUser(eventId, userId));

    if (Math.random() < this.abandonProbability()) {
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
        // 랜덤 지연이 입장 허가창보다 길어 허가가 자연 만료된 경우 — 확률적
        // 포기와 결과가 같으므로(둘 다 "예매를 시도 못 하고 나감") 같은
        // 카운터에 묶는다(demo.service.ts와 같은 판단).
        await this.redis.incr(`abandoned:event:${eventId}`);
        return;
      }
      if (e instanceof ConflictException) {
        return; // 재고 소진 — soldOut 카운터는 createHeld() 안에서 이미 증가됨
      }
      throw e;
    }
  }

  // reset이 이벤트 준비(없으면 생성)와 재고 재설정을 동시에 처리한다(2026-08-25
  // 사용자 결정) — 재고를 바꾸고 싶을 때마다 이 엔드포인트 하나만 부르면 된다.
  async reset(totalQty: number, userId: number) {
    const maxStock = this.maxStock();
    if (totalQty > maxStock) {
      throw new BadRequestException(`재고는 최대 ${maxStock}까지 가능합니다.`);
    }

    // 최초 호출이면 이 totalQty로 새로 생성되고, 이미 있으면 기존 이벤트를
    // 그대로 돌려받는다(EventsService 주석 참고) — 아래에서 명시적으로
    // totalQty를 다시 적용하므로 어느 쪽이든 최종 재고는 이번 요청값이 된다.
    const event = await this.eventsService.findOrCreateOwnLoadTestEvent(
      userId,
      totalQty,
    );

    // Payment→Reservation FK 때문에 예매보다 결제를 먼저 지운다(demo.service.ts와
    // 같은 이유 — 안 그러면 결제 기록이 하나라도 있으면 P2003으로 죽는다).
    await this.prisma.payment.deleteMany({
      where: { reservation: { eventId: event.id } },
    });
    await this.prisma.reservation.deleteMany({ where: { eventId: event.id } });
    await this.prisma.user.deleteMany({
      where: { email: { startsWith: this.virtualUserEmailPrefix(event.id) } },
    });

    const inventory = await this.prisma.inventory.update({
      where: { eventId: event.id },
      data: {
        totalQty,
        remainingQty: totalQty,
        version: { increment: 1 }, // 낙관적 락(W2) 전략과의 충돌 방지
      },
    });

    await this.redis.set(`stock:event:${event.id}`, totalQty);
    await this.redis.set(`soldout:event:${event.id}`, 0);
    await this.redis.set(`abandoned:event:${event.id}`, 0);
    // 리셋 전에 대기열에 남아있던 사람도 함께 비운다(demo.service.ts와 같은 이유).
    await this.queueService.purge(event.id);

    const updatedEvent = await this.prisma.event.update({
      where: { id: event.id },
      data: { openAt: new Date(), status: EventStatus.ON_SALE },
    });

    return { event: updatedEvent, inventory };
  }
}
