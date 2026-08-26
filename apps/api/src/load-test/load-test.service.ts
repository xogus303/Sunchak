import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  MessageEvent,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EventStatus, PaymentStatus, ReservationStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Observable, firstValueFrom, timer } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AdmissionModel, QueueService } from '../queue/queue.service';
import { QueueEventsService } from '../queue/queue-events.service';
import { EventsService } from '../events/events.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PaymentsService } from '../reservations/payments.service';
import {
  CONFIRM_QUEUE,
  HELD_ACTIVITY_KEY,
  HELD_ACTIVITY_TTL_MS,
} from '../reservations/reservations.constants';

// stats 스냅샷(캐주얼 데모의 DemoStats와 같은 목적) — 단, 개별 예매 목록
// (tickets)은 뺐다. 대용량 테스트는 재고·VU가 최대 10,000까지 가능해서
// 캐주얼 데모처럼 예매 건 하나하나를 매초 findMany+직렬화하면 부하가 커진다
// (2026-08-26 사용자와 논의해 확정 — 이 화면은 집계 숫자/게이지만 보여준다).
export interface LoadTestStats {
  totalQty: number;
  remainingQty: number;
  heldCount: number;
  confirmedCount: number;
  queueBacklog: number;
  paidCount: number;
  failedCount: number;
  soldOutCount: number;
  abandonedCount: number;
  admissionQueueCount: number;
}

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

  // 캐주얼 데모(demo.service.ts)와 같은 주기 — 대량 테스트라고 더 촘촘히
  // 볼 필요는 없고, 오히려 큰 숫자일수록 1초 단위 변화로도 충분히 체감된다.
  private readonly STATS_POLL_INTERVAL_MS = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly eventsService: EventsService,
    private readonly queueService: QueueService,
    private readonly queueEvents: QueueEventsService,
    private readonly reservations: ReservationsService,
    private readonly payments: PaymentsService,
    @InjectQueue(CONFIRM_QUEUE) private readonly confirmQueue: Queue,
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

  // load-test-admission.processor.ts와 정확히 같은 env 키·기본값 — 순번 SSE의
  // ETA 계산(QueueService.eta)이 실제 입장 처리 워커의 리듬을 그대로 반영하게
  // 하려면 두 곳이 같은 값을 봐야 한다(2026-08-26, ETA가 캐주얼 고정 공식을
  // 그대로 쓰다가 크게 틀렸던 버그를 고치며 추가 — 값 자체는 워커 쪽이 이미
  // 갖고 있던 걸 여기서도 읽을 뿐, 새 설정이 아니다).
  private admissionModel(): AdmissionModel {
    return {
      meanFraction: Number(
        this.config.get<string>('LOAD_TEST_ADMISSION_MEAN_FRACTION') ?? 0.2,
      ),
      minBatch: Number(
        this.config.get<string>('LOAD_TEST_ADMISSION_MIN_BATCH') ?? 50,
      ),
      maxBatch: Number(
        this.config.get<string>('LOAD_TEST_ADMISSION_MAX_BATCH') ?? 1_000,
      ),
      intervalMs: Number(
        this.config.get<string>('LOAD_TEST_ADMISSION_INTERVAL_MS') ?? 1_000,
      ),
    };
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

  // 실시간 결과 대시보드(demo.service.ts의 streamStats와 같은 구조) — 이벤트가
  // 아직 없으면(리셋 전) DEFAULT_STOCK으로 자동 생성한다(simulateLoad와 동일한
  // "최초 접근 시 준비" 관례).
  //
  // ⚠️ totalQty를 streamStats 시작 시 한 번만 읽어 클로저에 담아두지 않는다
  // (demo.service.ts의 streamStats와 다른 점) — 캐주얼 데모는 리셋해도 항상
  // 고정값(100)이라 안전했지만, 대량 테스트는 유저가 리셋마다 재고를 다르게
  // 정할 수 있어서 SSE 연결이 열려 있는 동안 리셋하면 옛 값을 계속 흘려보내는
  // 버그가 났다(2026-08-26, 브라우저 e2e로 실제로 재현·발견). getStats()가
  // 매 틱 DB에서 새로 읽는다.
  async streamStats(userId: number): Promise<Observable<MessageEvent>> {
    const event = await this.eventsService.findOrCreateOwnLoadTestEvent(
      userId,
      DEFAULT_STOCK,
    );
    const eventId = event.id;

    return timer(0, this.STATS_POLL_INTERVAL_MS).pipe(
      switchMap(() => this.getStats(eventId)),
      map((stats) => ({ data: stats }) as MessageEvent),
    );
  }

  private async getStats(eventId: number): Promise<LoadTestStats> {
    const [inventory, remaining, statusSums, waiting, active, paymentCounts, soldOut, abandoned, queued] =
      await Promise.all([
        this.prisma.inventory.findUnique({
          where: { eventId },
          select: { totalQty: true },
        }),
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
        // ⚠️ ReconcileProcessor(ADR 0021)가 "최근 예약 활동이 없으면" 하루
        // 한 번짜리 완화 모드로 빠진다 — 원래는 아무도 안 보는 유휴 시간의
        // Neon 비용을 아끼려는 취지였는데, 대용량 테스트는 정반대로 "사람이
        // 지금 이 화면을 실시간으로 보고 있는" 상황이라 그 취지와 안 맞는다.
        // 방문자가 이 SSE를 열어두고 있는 한(매 틱) 활동 신호를 계속 갱신해서,
        // 재고가 순간적으로 음수로 튀어도(동시성 경합상 정상) reconcile이 1분
        // 안에 바로 바로잡게 한다(2026-08-27, "재고가 -2로 고정된다" 실사용
        // 중 발견 — 이 신호가 90초 안에 안 갱신되면 다음 보정까지 최대 24시간
        // 걸릴 수 있었다). 어차피 이 stats 쿼리 자체가 이미 매초 Postgres를
        // 두드리고 있어(reservation.groupBy 등) 이 한 줄로 비용이 늘지 않는다.
        // 반환값은 안 쓰므로 구조분해 목록엔 안 넣는다.
        this.redis.set(HELD_ACTIVITY_KEY, '1', 'PX', HELD_ACTIVITY_TTL_MS),
      ]);

    const sumOf = (status: ReservationStatus) =>
      statusSums.find((s) => s.status === status)?._sum.quantity ?? 0;
    const countOf = (status: PaymentStatus) =>
      paymentCounts.find((p) => p.status === status)?._count._all ?? 0;

    return {
      totalQty: inventory?.totalQty ?? 0,
      // Redis 카운터(DECRBY 관문)는 동시 요청이 몰리면 보상(INCRBY)이 끝나기
      // 전 찰나에 음수를 찍을 수 있다 — 이건 내부 구현상 정상이지만(관문
      // 로직 자체가 이 값에 의존), 방문자에게 "재고가 마이너스"로 보이면
      // 안 된다(2026-08-27 실사용 중 발견). 표시용으로만 0 밑을 잘라낸다 —
      // 관문이 참조하는 원본 Redis 값 자체는 안 건드린다.
      remainingQty: Math.max(0, Number(remaining ?? 0)),
      heldCount: sumOf(ReservationStatus.HELD),
      confirmedCount: sumOf(ReservationStatus.CONFIRMED),
      queueBacklog: waiting + active,
      paidCount: countOf(PaymentStatus.PAID),
      failedCount: countOf(PaymentStatus.FAILED),
      soldOutCount: Number(soldOut ?? 0),
      abandonedCount: Number(abandoned ?? 0),
      admissionQueueCount: queued,
    };
  }

  // 방문자 본인이 대용량 이벤트의 대기열에 직접 들어가 순번을 받는다(2026-08-26,
  // 캐주얼 데모의 booking-form.tsx와 동일한 1인칭 체험을 대용량에도 제공하기
  // 위해 추가) — 지금까지 `/load-test`는 "가상 유저를 투입하고 집계만 지켜보는"
  // 관리자 콘솔이었고, 방문자 본인이 대기열에 서보는 경로가 없었다.
  //
  // ⚠️ 캐주얼 전용 `queueService.join()`을 재사용하면 안 된다 — `ACTIVE_QUEUES_KEY`
  // (AdmissionProcessor 전용)에 등록돼, `LoadTestAdmissionProcessor`가 이미
  // 순회 중인 이벤트를 두 워커가 동시에 ZPOPMIN하는 경합이 재현된다(2026-08-25
  // 세션이 이 둘을 완전히 분리한 이유 그대로). 반드시 `joinLoadTest()`를 쓴다.
  //
  // 프론트는 자기 이벤트 id를 미리 모르므로(캐주얼처럼 URL에 :eventId가 없다)
  // 응답에 eventId를 실어 보낸다 — 이후 예매(`POST /events/:eventId/reservations`)
  // 호출에 이 값을 그대로 쓴다.
  async joinQueue(userId: number): Promise<{ eventId: number }> {
    const event = await this.eventsService.findOrCreateOwnLoadTestEvent(
      userId,
      DEFAULT_STOCK,
    );
    await this.queueService.joinLoadTest(event.id, userId);
    return { eventId: event.id };
  }

  // 순번/입장허가 스트림 자체(폴링·방송 구독 로직)는 이벤트-무관해 그대로
  // 재사용하지만, ETA 계산은 대용량 전용 admissionModel을 반드시 넘겨야 한다 —
  // 안 넘기면 QueueService가 캐주얼 고정 배치 공식으로 계산해 실제 배출
  // 속도와 안 맞는 ETA가 나온다(위 admissionModel() 주석 참고).
  async streamQueueStatus(userId: number): Promise<Observable<MessageEvent>> {
    const event = await this.eventsService.findOrCreateOwnLoadTestEvent(
      userId,
      DEFAULT_STOCK,
    );
    return this.queueService.streamStatus(
      event.id,
      userId,
      this.admissionModel(),
    );
  }
}
