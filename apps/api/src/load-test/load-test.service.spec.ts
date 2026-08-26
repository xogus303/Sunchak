import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { PaymentStatus, ReservationStatus } from '@prisma/client';
import { LoadTestService } from './load-test.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { QueueEventsService } from '../queue/queue-events.service';
import { EventsService } from '../events/events.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PaymentsService } from '../reservations/payments.service';
import { CONFIRM_QUEUE, HELD_ACTIVITY_KEY } from '../reservations/reservations.constants';
import { ACTIVE_QUEUES_KEY, LOAD_TEST_ACTIVE_QUEUES_KEY } from '../queue/queue.constants';

// stats가 큐 적체를 조회할 때 부르는 두 메서드만 흉내낸다(demo.service.spec.ts와
// 같은 이유 — 실제 큐 불필요).
const confirmQueueMock = {
  getWaitingCount: jest.fn().mockResolvedValue(0),
  getActiveCount: jest.fn().mockResolvedValue(0),
};

// join/reset의 핵심(실제 DB 삭제·재고 갱신·Redis 동기화)은 실제 DB·Redis가
// 있어야 의미 있게 검증된다(demo.service.spec.ts와 같은 이유). 실제 투입 파이프라인
// (ReservationsService.create/PaymentsService.pay)은 여기 스펙의 관심사가 아니라
// 스텁으로 대체 — 이 스펙은 게이트·리셋만 검증하고, 입장 처리 워커가 없어
// 투입된 가상 유저는 실제로 허가를 못 받는다(백그라운드에서 조용히 대기만 함,
// fire-and-forget이라 테스트 실패로 이어지지 않는다 — demo.service.spec.ts와 같은 패턴).
describe('LoadTestService (통합 — 대용량 트래픽 테스트, ADR 0016 백로그)', () => {
  let moduleRef: TestingModule;
  let service: LoadTestService;
  let prisma: PrismaService;
  let redis: RedisService;

  let userId: number;

  const reservationsCreateMock = jest.fn().mockResolvedValue({ id: 1 });
  const paymentsPayMock = jest.fn().mockResolvedValue({});

  beforeAll(async () => {
    process.env.LOAD_TEST_MAX_VU = '100';
    process.env.LOAD_TEST_MAX_STOCK = '100';
    process.env.LOAD_TEST_COOLDOWN_MS = '60000'; // 개별 테스트가 필요 시 더 짧게 덮어씀

    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        LoadTestService,
        PrismaService,
        RedisService,
        QueueService,
        QueueEventsService,
        EventsService,
        { provide: ReservationsService, useValue: { create: reservationsCreateMock } },
        { provide: PaymentsService, useValue: { pay: paymentsPayMock } },
        { provide: getQueueToken(CONFIRM_QUEUE), useValue: confirmQueueMock },
      ],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(LoadTestService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    delete process.env.LOAD_TEST_MAX_VU;
    delete process.env.LOAD_TEST_MAX_STOCK;
    delete process.env.LOAD_TEST_COOLDOWN_MS;
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.payment.deleteMany();
    await prisma.reservation.deleteMany();
    await prisma.inventory.deleteMany();
    await prisma.event.deleteMany();
    await prisma.user.deleteMany();

    const user = await prisma.user.create({
      data: { email: `loadtest-owner-${randomUUID()}@test.local`, password: 'x' },
    });
    userId = user.id;
  });

  describe('simulateLoad (게이트)', () => {
    it('상한(LOAD_TEST_MAX_VU)을 넘으면 거부한다', async () => {
      await expect(service.simulateLoad(101, userId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('상한 이내면 통과하고 accepted를 그대로 돌려준다', async () => {
      // 큰 값(예: 50)을 쓰면 백그라운드 투입(fire-and-forget)이 다음 테스트의
      // beforeEach 정리와 겹쳐 불필요한 잡음이 생길 수 있어 작게 유지한다.
      await expect(service.simulateLoad(3, userId)).resolves.toEqual({ accepted: 3 });
    });

    it('쿨다운 중 재요청은 거부한다', async () => {
      await service.simulateLoad(1, userId);
      await expect(service.simulateLoad(1, userId)).rejects.toBeInstanceOf(HttpException);
    });

    it('쿨다운은 유저별로 분리된다 — 다른 유저는 막히지 않는다', async () => {
      await service.simulateLoad(1, userId);
      const otherUser = await prisma.user.create({
        data: { email: `loadtest-other-${randomUUID()}@test.local`, password: 'x' },
      });

      await expect(service.simulateLoad(1, otherUser.id)).resolves.toEqual({ accepted: 1 });
    });

    it('처음 호출하면 이 유저 전용 대용량 테스트 이벤트가 생성된다', async () => {
      await service.simulateLoad(1, userId);

      const event = await prisma.event.findUnique({ where: { loadTestOwnerId: userId } });
      expect(event).not.toBeNull();
      expect(event!.isDemo).toBe(true); // 공개 목록(findAll)에 안 섞이게 하는 표식
    });
  });

  describe('reset', () => {
    it('상한(LOAD_TEST_MAX_STOCK)을 넘으면 거부한다', async () => {
      await expect(service.reset(101, userId)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('처음 호출하면 지정한 재고로 이벤트를 새로 만든다', async () => {
      const result = await service.reset(50, userId);

      expect(result.inventory.totalQty).toBe(50);
      expect(result.inventory.remainingQty).toBe(50);
      await expect(redis.get(`stock:event:${result.event.id}`)).resolves.toBe('50');
    });

    it('이미 이벤트가 있으면 재고를 새 값으로 재설정한다(이벤트는 재사용)', async () => {
      const first = await service.reset(30, userId);
      const second = await service.reset(80, userId);

      expect(second.event.id).toBe(first.event.id); // 같은 이벤트를 계속 재사용
      expect(second.inventory.totalQty).toBe(80);
      await expect(redis.get(`stock:event:${first.event.id}`)).resolves.toBe('80');
    });

    it('리셋 시 대기열에 남아있던 사람도 함께 비운다', async () => {
      const result = await service.reset(30, userId);
      const queueService = moduleRef.get(QueueService);
      await queueService.joinLoadTest(result.event.id, userId);

      await service.reset(30, userId);

      await expect(queueService.status(result.event.id, userId)).resolves.toEqual({
        rank: null,
        admitted: false,
        etaSeconds: null,
      });
      await expect(
        redis.sismember(LOAD_TEST_ACTIVE_QUEUES_KEY, String(result.event.id)),
      ).resolves.toBe(0);
    });

    it('리셋은 결제 기록이 있는 예매도 FK 위반 없이 함께 삭제한다', async () => {
      const result = await service.reset(30, userId);
      const reservation = await prisma.reservation.create({
        data: {
          userId,
          eventId: result.event.id,
          quantity: 1,
          idempotencyKey: randomUUID(),
        },
      });
      await prisma.payment.create({
        data: {
          reservationId: reservation.id,
          amount: 10000,
          idempotencyKey: randomUUID(),
        },
      });

      await expect(service.reset(30, userId)).resolves.toBeDefined();
      await expect(prisma.reservation.findUnique({ where: { id: reservation.id } })).resolves.toBeNull();
    });

    it('가상 유저(loadtest- 접두사)만 골라 지우고 실제 소유자 계정은 안 건드린다', async () => {
      const result = await service.reset(30, userId);
      const virtualUser = await prisma.user.create({
        data: { email: `loadtest-${result.event.id}-${randomUUID()}@sunchak.demo`, password: null },
      });

      await service.reset(30, userId);

      await expect(prisma.user.findUnique({ where: { id: virtualUser.id } })).resolves.toBeNull();
      await expect(prisma.user.findUnique({ where: { id: userId } })).resolves.not.toBeNull();
    });
  });

  describe('stats 대시보드', () => {
    it('대용량 테스트 이벤트가 없으면 새로 만들어 빈 스냅샷을 흘려보낸다', async () => {
      const msg = await firstValueFrom(await service.streamStats(userId));

      // DEFAULT_STOCK(1000) — 리셋 없이 stats를 먼저 열어도 이벤트가 자동
      // 생성된다(simulateLoad와 동일한 관례).
      expect(msg.data).toMatchObject({ totalQty: 1000, remainingQty: 1000, heldCount: 0, confirmedCount: 0 });
    });

    // 2026-08-27 실사용 중 발견 — 관문의 Redis DECRBY가 대량 동시 요청 중
    // 보상 전 찰나에 음수를 찍을 수 있는데(내부 구현상 정상), 그 값을 그대로
    // 노출하면 방문자에게 "재고가 마이너스"로 보인다. 표시값은 0 밑을 잘라낸다.
    it('Redis의 원본 재고 값이 음수여도 remainingQty는 0으로 표시한다', async () => {
      const result = await service.reset(10, userId);
      await redis.set(`stock:event:${result.event.id}`, '-3');

      const msg = await firstValueFrom(await service.streamStats(userId));

      expect(msg.data).toMatchObject({ remainingQty: 0 });
    });

    // 2026-08-27 실사용 중 발견 — "재고가 -2로 고정된다"는 버그. 대용량 화면을
    // 실시간으로 보는 동안엔 순간적인 음수 튐(동시성 경합상 정상)이 1분 안에
    // 바로잡혀야 하는데, ReconcileProcessor(ADR 0021)가 "최근 활동 없음"으로
    // 판단하면 다음 보정까지 최대 24시간짜리 완화 모드로 빠졌다. stats를 볼
    // 때마다 활동 신호를 갱신해 이 완화 모드에 안 빠지게 한다.
    it('stats를 조회할 때마다 HELD_ACTIVITY_KEY를 갱신한다(ReconcileProcessor가 유휴로 오판해 24시간 완화 모드로 빠지는 것 방지)', async () => {
      await redis.del(HELD_ACTIVITY_KEY);

      await firstValueFrom(await service.streamStats(userId));

      await expect(redis.exists(HELD_ACTIVITY_KEY)).resolves.toBe(1);
      const ttl = await redis.pttl(HELD_ACTIVITY_KEY);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(90_000);
    });

    it('재고·HELD/CONFIRMED 합계·큐 적체·결제 성공/실패·재고소진·포기·입장대기를 집계한다(개별 예매 목록 없이)', async () => {
      const result = await service.reset(10, userId);
      const eventId = result.event.id;
      await redis.set(`stock:event:${eventId}`, '4');
      await redis.set(`soldout:event:${eventId}`, '5');
      await redis.set(`abandoned:event:${eventId}`, '2');
      const queueService = moduleRef.get(QueueService);
      await queueService.joinLoadTest(eventId, 9001);
      await queueService.joinLoadTest(eventId, 9002);

      await prisma.reservation.create({
        data: {
          userId,
          eventId,
          quantity: 3,
          idempotencyKey: randomUUID(),
          status: ReservationStatus.HELD,
          heldUntil: new Date(Date.now() + 60_000),
        },
      });
      const confirmed = await prisma.reservation.create({
        data: {
          userId,
          eventId,
          quantity: 2,
          idempotencyKey: randomUUID(),
          status: ReservationStatus.CONFIRMED,
        },
      });
      const cancelled = await prisma.reservation.create({
        data: {
          userId,
          eventId,
          quantity: 1,
          idempotencyKey: randomUUID(),
          status: ReservationStatus.CANCELLED,
        },
      });
      await prisma.payment.create({
        data: {
          reservationId: confirmed.id,
          amount: 20000,
          idempotencyKey: randomUUID(),
          status: PaymentStatus.PAID,
        },
      });
      await prisma.payment.create({
        data: {
          reservationId: cancelled.id,
          amount: 10000,
          idempotencyKey: randomUUID(),
          status: PaymentStatus.FAILED,
        },
      });
      confirmQueueMock.getWaitingCount.mockResolvedValue(1);
      confirmQueueMock.getActiveCount.mockResolvedValue(1);

      const msg = await firstValueFrom(await service.streamStats(userId));

      expect(msg.data).toEqual({
        totalQty: 10,
        remainingQty: 4,
        heldCount: 3,
        confirmedCount: 2,
        queueBacklog: 2, // waiting(1) + active(1)
        paidCount: 1,
        failedCount: 1,
        soldOutCount: 5,
        abandonedCount: 2,
        admissionQueueCount: 2,
      });

      confirmQueueMock.getWaitingCount.mockResolvedValue(0);
      confirmQueueMock.getActiveCount.mockResolvedValue(0);
    });
  });

  describe('joinQueue / streamQueueStatus (방문자 본인의 1인칭 대기열 체험)', () => {
    it('처음 호출하면 이 유저 전용 대용량 테스트 이벤트를 만들고 그 eventId를 돌려준다', async () => {
      const result = await service.joinQueue(userId);

      const event = await prisma.event.findUnique({ where: { loadTestOwnerId: userId } });
      expect(result).toEqual({ eventId: event!.id });
    });

    it('캐주얼 전용 활성 목록(ACTIVE_QUEUES_KEY)이 아니라 LOAD_TEST_ACTIVE_QUEUES_KEY에 등록된다', async () => {
      const { eventId } = await service.joinQueue(userId);

      await expect(
        redis.sismember(LOAD_TEST_ACTIVE_QUEUES_KEY, String(eventId)),
      ).resolves.toBe(1);
      await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(0);
    });

    it('대기열에 실제로 순번이 매겨진다(QueueService.status로 확인)', async () => {
      const { eventId } = await service.joinQueue(userId);
      const queueService = moduleRef.get(QueueService);

      await expect(queueService.status(eventId, userId)).resolves.toEqual({
        rank: 0,
        admitted: false,
        etaSeconds: expect.any(Number),
      });
    });

    it('streamQueueStatus는 join 직후의 순번 스냅샷을 흘려보낸다', async () => {
      const { eventId } = await service.joinQueue(userId);

      const msg = await firstValueFrom(await service.streamQueueStatus(userId));

      // waiting=1(본인 혼자) → expectedBatch=clamp(1*0.2, 50, 1000)=50(minBatch clamp)
      // → batchesAhead=ceil(1/50)=1 → eta=1*(1000/1000)=1초.
      // ⚠️ 캐주얼 고정 공식(ADMISSION_BATCH_SIZE=20/INTERVAL=2000ms)이었다면 2초가
      // 나왔을 것 — 1초가 나온다는 건 대용량 전용 admissionModel이 실제로 쓰였다는
      // 증거다(2026-08-26 실사용 중 발견한 ETA 오차 버그의 회귀 테스트).
      expect(msg.data).toEqual({ rank: 0, admitted: false, etaSeconds: 1 });
      // 같은 이벤트를 가리키는지도 확인 — join 응답의 eventId와 실제 소유 이벤트가 일치.
      const event = await prisma.event.findUnique({ where: { loadTestOwnerId: userId } });
      expect(event!.id).toBe(eventId);
    });
  });
});
