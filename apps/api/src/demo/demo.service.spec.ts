import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { EventStatus, PaymentStatus, ReservationStatus } from '@prisma/client';
import { DemoService } from './demo.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PaymentsService } from '../reservations/payments.service';
import { CONFIRM_QUEUE } from '../reservations/reservations.constants';
import { QueueService } from '../queue/queue.service';
import { QueueEventsService } from '../queue/queue-events.service';
import { AdmissionProcessor } from '../queue/admission.processor';
import { ADMISSION_QUEUE, ACTIVE_QUEUES_KEY } from '../queue/queue.constants';
import { EventsService } from '../events/events.service';

const TEST_GATE_PASSWORD = 'sunchak-test';
const SIM_COOLDOWN_KEY = 'demo:sim:cooldown';
const AUTO_SIM_COOLDOWN_KEY = 'demo:sim:auto-cooldown';

// 리셋의 핵심(실제 삭제·재고 원복·Redis 동기화)은 실제 DB·Redis가 있어야
// 의미 있게 검증된다.
describe('DemoService (통합 — 데모 리셋)', () => {
  let moduleRef: TestingModule;
  let service: DemoService;
  let prisma: PrismaService;
  let redis: RedisService;

  let userId: number;
  let eventId: number;

  const stockKey = () => `stock:event:${eventId}`;
  const soldOutKey = () => `soldout:event:${eventId}`;
  const abandonedKey = () => `abandoned:event:${eventId}`;
  const readStock = async () => Number(await redis.get(stockKey()));

  // 실제 파이프라인(큐·워커)까지는 이 스펙의 관심사가 아니다 — 시뮬레이션이
  // ReservationsService.create·PaymentsService.pay를 '호출하는지'만 확인하면
  // 되므로 스텁으로 대체(결제까지 이어 호출하는 것은 2026-08-06에 추가된 동작).
  const reservationsCreateMock = jest.fn().mockResolvedValue({ id: 1 });
  const paymentsPayMock = jest.fn().mockResolvedValue({});

  // stats가 큐 적체를 조회할 때 부르는 두 메서드만 흉내낸다(실제 큐 불필요).
  const confirmQueueMock = {
    getWaitingCount: jest.fn().mockResolvedValue(0),
    getActiveCount: jest.fn().mockResolvedValue(0),
  };

  let admissionProcessor: AdmissionProcessor;

  beforeAll(async () => {
    process.env.DEMO_GATE_PASSWORD = TEST_GATE_PASSWORD; // ConfigModule 로드 전에 세팅
    process.env.DEMO_SIM_MAX_VU = '10';
    process.env.DEMO_SIM_COOLDOWN_MS = '60000';
    // 가상 유저 현실성(ADR 0017)의 랜덤 지연은 운영값(최대 35초)으로 두면 테스트가
    // 너무 느려진다 — 기본값을 아주 짧게 덮어쓰고, 포기/만료를 검증하는 개별 테스트만
    // 필요할 때 다시 덮어쓴다.
    process.env.DEMO_SIM_ABANDON_PROBABILITY = '0';
    process.env.DEMO_SIM_MIN_BOOKING_DELAY_MS = '10';
    process.env.DEMO_SIM_MAX_BOOKING_DELAY_MS = '20';
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({ secret: 'test-secret' }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            const url = new URL(
              config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
            );
            return { connection: { host: url.hostname, port: Number(url.port) || 6379 } };
          },
        }),
        BullModule.registerQueue({ name: ADMISSION_QUEUE }),
      ],
      providers: [
        DemoService,
        PrismaService,
        RedisService,
        QueueService,
        QueueEventsService,
        AdmissionProcessor,
        EventsService, // 유저별 격리(2026-08-07) — DemoService가 "내 데모 이벤트"를 여기서 얻는다.
        { provide: ReservationsService, useValue: { create: reservationsCreateMock } },
        { provide: PaymentsService, useValue: { pay: paymentsPayMock } },
        { provide: getQueueToken(CONFIRM_QUEUE), useValue: confirmQueueMock },
      ],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(DemoService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);
    admissionProcessor = moduleRef.get(AdmissionProcessor);
  });

  afterAll(async () => {
    delete process.env.DEMO_GATE_PASSWORD; // 다른 스펙 파일에 안 새게 정리
    delete process.env.DEMO_SIM_MAX_VU;
    delete process.env.DEMO_SIM_COOLDOWN_MS;
    delete process.env.DEMO_SIM_ABANDON_PROBABILITY;
    delete process.env.DEMO_SIM_MIN_BOOKING_DELAY_MS;
    delete process.env.DEMO_SIM_MAX_BOOKING_DELAY_MS;
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.payment.deleteMany(); // Payment→Reservation FK를 먼저 지워야 아래 delete가 성공한다(ADR 0018)
    await prisma.reservation.deleteMany();
    await prisma.inventory.deleteMany();
    await prisma.event.deleteMany();
    await prisma.user.deleteMany();
    reservationsCreateMock.mockClear();
    paymentsPayMock.mockClear();
    confirmQueueMock.getWaitingCount.mockClear().mockResolvedValue(0);
    confirmQueueMock.getActiveCount.mockClear().mockResolvedValue(0);

    const user = await prisma.user.create({
      data: { email: `demo-${randomUUID()}@test.local`, password: 'x' },
    });
    userId = user.id;
  });

  afterEach(async () => {
    if (eventId) await redis.del(stockKey(), soldOutKey(), abandonedKey());
    await redis.del(SIM_COOLDOWN_KEY, AUTO_SIM_COOLDOWN_KEY); // 다음 테스트에 쿨다운 잠금이 새지 않게
    if (eventId) {
      await redis.del(`queue:event:${eventId}`);
      await redis.srem(ACTIVE_QUEUES_KEY, String(eventId));
    }
  });

  // demoOwnerId를 지정해야 DemoService가 내부적으로 부르는
  // findOrCreateOwnDemoEvent(userId)가 "이미 있다"고 보고 이 행을 그대로 쓴다
  // (2026-08-07, 유저별 격리 — 안 지정하면 매번 새 이벤트를 만들어버린다).
  const createDemoEvent = (totalQty: number, ownerId: number = userId) =>
    prisma.event.create({
      data: {
        title: '테스트 데모 이벤트',
        price: 10000,
        openAt: new Date('2020-01-01T00:00:00.000Z'), // 과거 — 리셋이 갱신하는지 확인용
        status: EventStatus.SOLD_OUT, // 리셋이 ON_SALE로 되돌리는지 확인용
        isDemo: true,
        demoOwnerId: ownerId,
        inventory: { create: { totalQty, remainingQty: 0 } },
      },
      include: { inventory: true },
    });

  // 데모 이벤트가 아직 없어도 더 이상 404가 아니다 — 2026-08-07 유저별 격리
  // 도입으로 findOrCreateOwnDemoEvent가 그 자리에서 "내 것"을 만들어준다.
  it('데모 이벤트가 없으면 새로 만들어 리셋한다', async () => {
    const result = await service.resetDemoEvent(userId);

    expect(result.inventory.remainingQty).toBe(100); // 새로 만든 기본값
    const created = await prisma.event.findUnique({ where: { demoOwnerId: userId } });
    expect(created).not.toBeNull();
    eventId = created!.id; // afterEach 정리 대상으로 등록
  });

  it('예매를 지우고 재고를 totalQty로, Redis도 같은 값으로 되돌린다', async () => {
    const event = await createDemoEvent(10);
    eventId = event.id;
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
    await redis.set(stockKey(), '7'); // 관문이 이미 3장 깎아둔 상태를 흉내

    const result = await service.resetDemoEvent(userId);

    expect(result.inventory.remainingQty).toBe(10);
    await expect(prisma.reservation.count()).resolves.toBe(0);
    await expect(readStock()).resolves.toBe(10);
  });

  // ADR 0018로 Payment→Reservation FK가 생긴 뒤 발견한 회귀 버그(2026-08-06) —
  // 결제 기록이 하나라도 있으면 reservation.deleteMany()가 P2003으로 그대로
  // 500 에러가 났다. payment를 먼저 지우도록 고친 걸 검증한다.
  it('결제 기록(Payment)이 있는 예매도 FK 위반 없이 함께 삭제된다', async () => {
    const event = await createDemoEvent(10);
    eventId = event.id;
    const reservation = await prisma.reservation.create({
      data: {
        userId,
        eventId,
        quantity: 2,
        idempotencyKey: randomUUID(),
        status: ReservationStatus.HELD,
        heldUntil: new Date(Date.now() + 60_000),
      },
    });
    await prisma.payment.create({
      data: {
        reservationId: reservation.id,
        amount: 20000,
        idempotencyKey: randomUUID(),
        status: PaymentStatus.PENDING,
      },
    });

    await expect(service.resetDemoEvent(userId)).resolves.toBeDefined(); // 던지지 않아야 함(P2003 재발 방지)

    await expect(prisma.payment.count()).resolves.toBe(0);
    await expect(prisma.reservation.count()).resolves.toBe(0);
  });

  it('openAt을 현재로, status를 ON_SALE로 되돌린다', async () => {
    const event = await createDemoEvent(5);
    eventId = event.id;

    const before = Date.now();
    const result = await service.resetDemoEvent(userId);

    expect(result.event.status).toBe(EventStatus.ON_SALE);
    expect(result.event.openAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('isDemo가 아닌 이벤트는 리셋 대상에서 제외한다(내 이벤트만 새로 만들어 리셋)', async () => {
    const other = await prisma.event.create({
      data: {
        title: '수동 테스트용 이벤트(데모 아님)',
        price: 5000,
        openAt: new Date(),
        isDemo: false,
        inventory: { create: { totalQty: 20, remainingQty: 20 } },
      },
    });

    const result = await service.resetDemoEvent(userId);
    eventId = result.event.id; // afterEach 정리 대상으로 등록

    expect(result.event.id).not.toBe(other.id); // other가 아니라 내 전용 이벤트가 새로 생김
    const untouched = await prisma.inventory.findUniqueOrThrow({
      where: { eventId: other.id },
    });
    expect(untouched.remainingQty).toBe(20); // 손대지 않음
  });

  it('시뮬레이션이 만든 sim- 접두사 유저는 지우고, 일반 유저는 남긴다', async () => {
    const event = await createDemoEvent(10);
    eventId = event.id;
    // 이메일이 이벤트별로 스코프된다(2026-08-07, 유저별 격리) — sim-{eventId}-...
    await prisma.user.create({
      data: { email: `sim-${eventId}-${randomUUID()}@sunchak.demo`, password: null },
    });

    await service.resetDemoEvent(userId);

    const remainingEmails = (await prisma.user.findMany()).map((u) => u.email);
    expect(remainingEmails.some((e) => e.startsWith('sim-'))).toBe(false);
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  // 실사용 중 발견(2026-08-06) — 리셋이 재고·예매만 원복하고 대기열은 안 비워서,
  // 리셋 전에 대기 중이던 사람들이 리셋 후에도 계속 입장 허가를 받아 방금
  // 원복한 재고를 또 깎는 문제가 있었다. 대기열도 함께 비워지는지 검증.
  it('리셋 시 대기열에 남아있던 사람도 함께 비운다', async () => {
    const event = await createDemoEvent(10);
    eventId = event.id;
    const queueService = moduleRef.get(QueueService);
    await queueService.join(eventId, userId);

    await service.resetDemoEvent(userId);

    await expect(queueService.status(eventId, userId)).resolves.toEqual({
      rank: null,
      admitted: false,
    });
    await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(0);
  });

  describe('시뮬레이션 (축 B-1)', () => {
    it('가상 유저 수가 상한(DEMO_SIM_MAX_VU)을 넘으면 400을 던진다', async () => {
      await expect(service.simulateLoad(11, userId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(reservationsCreateMock).not.toHaveBeenCalled();
    });

    it('정상 요청이면 즉시 accepted를 반환하고, 대기열을 거쳐 백그라운드에서 가상 유저를 실제로 투입한다', async () => {
      const event = await createDemoEvent(10);
      eventId = event.id;

      const result = await service.simulateLoad(1, userId);
      expect(result).toEqual({ accepted: 1 });

      await new Promise((res) => setTimeout(res, 100)); // 가상 유저 생성 + 대기열 join 여유
      await admissionProcessor.process({} as Job); // 실제 2초 반복 타이머를 기다리지 않고 즉시 입장 처리
      await new Promise((res) => setTimeout(res, 100)); // 입장 허가 후 랜덤 지연(테스트값 10~20ms) 여유

      expect(reservationsCreateMock).toHaveBeenCalledWith(
        event.id,
        expect.any(Number),
        1,
        'held',
        expect.any(String),
      );
      // 2026-08-06 추가 — 예매 성공 후 결제까지 이어서 호출해야 CONFIRMED/CANCELLED로
      // 넘어간다(안 그러면 가상 유저가 전부 HELD에서 멈추는 버그를 실사용 중 발견).
      expect(paymentsPayMock).toHaveBeenCalledWith(1, expect.any(Number), expect.any(String));
      const simUsers = await prisma.user.findMany({
        where: { email: { startsWith: 'sim-' } },
      });
      expect(simUsers).toHaveLength(1);
    });

    it('입장 허가를 받아도 확률적으로 포기하면 예매를 시도하지 않는다', async () => {
      process.env.DEMO_SIM_ABANDON_PROBABILITY = '1'; // 항상 포기
      const event = await createDemoEvent(10);
      eventId = event.id;

      await service.simulateLoad(1, userId);
      await new Promise((res) => setTimeout(res, 100));
      await admissionProcessor.process({} as Job);
      await new Promise((res) => setTimeout(res, 100));

      expect(reservationsCreateMock).not.toHaveBeenCalled();
      expect(paymentsPayMock).not.toHaveBeenCalled();
      // 예매를 안 하니 재고소진 실패로도 안 잡힌다 — 별도 카운터가 없으면
      // "투입 인원수와 스탯 합계가 안 맞는다"는 혼란이 생긴다(2026-08-06 실사용 중 발견).
      await expect(redis.get(abandonedKey())).resolves.toBe('1');
      process.env.DEMO_SIM_ABANDON_PROBABILITY = '0'; // 다음 테스트를 위해 복원
    });

    it('예매 시도까지의 지연이 입장 허가창을 넘기면 조용히 실패한다(재시도 없음)', async () => {
      process.env.QUEUE_ADMISSION_WINDOW_MS = '20'; // 허가창을 지연(10~20ms)보다 더 짧게
      process.env.DEMO_SIM_MIN_BOOKING_DELAY_MS = '50';
      process.env.DEMO_SIM_MAX_BOOKING_DELAY_MS = '60';
      const event = await createDemoEvent(10);
      eventId = event.id;

      await service.simulateLoad(1, userId);
      await new Promise((res) => setTimeout(res, 100));
      await admissionProcessor.process({} as Job);
      await new Promise((res) => setTimeout(res, 150)); // 허가창 만료 + 지연 끝 여유

      expect(reservationsCreateMock).not.toHaveBeenCalled();
      expect(paymentsPayMock).not.toHaveBeenCalled();
      // 확률적 포기와 결과가 같아(예매를 시도 못 하고 나감) 같은 카운터에
      // 묶인다(2026-08-06, "투입 인원수와 스탯 합계가 안 맞는다" 회귀 방지).
      await expect(redis.get(abandonedKey())).resolves.toBe('1');
      delete process.env.QUEUE_ADMISSION_WINDOW_MS;
      process.env.DEMO_SIM_MIN_BOOKING_DELAY_MS = '10'; // 다음 테스트를 위해 복원
      process.env.DEMO_SIM_MAX_BOOKING_DELAY_MS = '20';
    });

    it('쿨다운 중 재요청은 429를 던진다', async () => {
      const event = await createDemoEvent(10);
      eventId = event.id;

      await service.simulateLoad(1, userId);
      await expect(service.simulateLoad(1, userId)).rejects.toBeInstanceOf(
        HttpException,
      );
    });

    // 이벤트 상세 페이지 마운트 시 자동 투입(2026-08-07)은 수동 버튼과 완전히
    // 별개의 쿨다운을 써야 한다 — 안 그러면 방문자가 뒤로 가기→재입장을 반복할
    // 때마다 대기열이 텅 비어 보이는 문제가 있었다(사용자가 직접 재현해 발견).
    it('자동 투입(auto=true)은 수동 쿨다운과 별개의 쿨다운을 쓴다', async () => {
      const event = await createDemoEvent(10);
      eventId = event.id;

      await service.simulateLoad(1, userId); // 수동 쿨다운 잠금
      await expect(service.simulateLoad(1, userId, true)).resolves.toEqual({ accepted: 1 }); // auto는 안 막힘

      await expect(service.simulateLoad(1, userId, true)).rejects.toBeInstanceOf(HttpException); // auto 쿨다운은 이제 잠김
      await expect(service.simulateLoad(2, userId)).rejects.toBeInstanceOf(HttpException); // 수동 쿨다운은 여전히 잠긴 채
    });

    // 방문자 본인의 대기열 입장(단순 ZADD)이 가상 유저의 입장(User 생성 후
    // ZADD, 더 느림)보다 항상 먼저 끝나 늘 0번을 받던 문제(2026-08-07 실사용
    // 중 발견)의 회귀 테스트 — auto=true는 응답이 오는 시점에 이미 전원이
    // 대기열에 서 있어야 한다(별도로 기다릴 필요 없이 즉시 확인 가능해야 함).
    it('자동 투입(auto=true)은 응답 시점에 이미 전원이 대기열 입장을 마친 상태다', async () => {
      const event = await createDemoEvent(10);
      eventId = event.id;
      const queueService = moduleRef.get(QueueService);

      await service.simulateLoad(5, userId, true);

      await expect(queueService.size(eventId)).resolves.toBe(5);
    });

    // 유저별 격리(2026-08-07)의 핵심 계약 — 한 유저의 쿨다운이 다른 유저의
    // 시뮬레이션을 막으면 안 된다(안 그러면 두 사람이 동시에 테스트할 때
    // 서로를 방해한다).
    it('한 유저의 쿨다운은 다른 유저의 시뮬레이션을 막지 않는다', async () => {
      const otherUser = await prisma.user.create({
        data: { email: `other-${randomUUID()}@test.local`, password: 'x' },
      });
      const event = await createDemoEvent(10);
      eventId = event.id;

      await service.simulateLoad(1, userId); // 내 쿨다운만 잠금

      await expect(service.simulateLoad(1, otherUser.id)).resolves.toEqual({
        accepted: 1,
      }); // 다른 유저는 안 막힘 — 이 호출이 otherUser 전용 데모 이벤트를 새로 만든다

      const otherEvent = await prisma.event.findUniqueOrThrow({
        where: { demoOwnerId: otherUser.id },
      });
      await redis.del(`queue:event:${otherEvent.id}`, `demo:sim:cooldown:${otherUser.id}`);
      await redis.srem(ACTIVE_QUEUES_KEY, String(otherEvent.id));
    });
  });

  describe('stats 대시보드 (축 B-2)', () => {
    it('데모 이벤트가 없으면 새로 만들어 빈 스냅샷을 흘려보낸다', async () => {
      const msg = await firstValueFrom(await service.streamStats(userId));

      // remainingQty:100 — 새로 만든 데모 이벤트의 전체 재고. 예매가 하나도
      // 없으니 HELD/CONFIRMED는 0이지만, 재고 자체는 꽉 차 있어야 정상이다
      // (2026-08-07: EventsService가 생성 시 stock:event Redis 키도 함께
      // 심게 고치기 전에는 이 값이 버그로 0이 나왔었다).
      expect(msg.data).toMatchObject({ remainingQty: 100, heldCount: 0, confirmedCount: 0 });
      const created = await prisma.event.findUnique({ where: { demoOwnerId: userId } });
      expect(created).not.toBeNull();
      eventId = created!.id; // afterEach 정리 대상으로 등록
    });

    it('재고·HELD/CONFIRMED 합계·큐 적체·결제 성공/실패·재고소진·포기·티켓 목록을 스냅샷으로 흘려보낸다', async () => {
      const event = await createDemoEvent(10);
      eventId = event.id;
      await redis.set(stockKey(), '4'); // 재고 잔량
      await redis.set(soldOutKey(), '5'); // 재고 소진으로 예매 자체가 막힌 시도 수
      await redis.set(abandonedKey(), '2'); // 입장 허가를 받고도 시도하지 않고 나간 수
      // 입장 대기열(ADR 0017)에 아직 허가를 못 받고 남아있는 인원 — Redis만 쓰므로
      // 실제 User 행 없이도 join 가능(2026-08-06 사용자 요청으로 추가한 지표).
      const queueService = moduleRef.get(QueueService);
      await queueService.join(eventId, 9001);
      await queueService.join(eventId, 9002);

      const held = await prisma.reservation.create({
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
      // 판매 현황 통합(2026-08-06 PRD 재검토) — 결제 성공/실패 집계용.
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
        // 전부 userId로 만든 예매라 isMine:true — 이벤트가 유저별로 격리돼
        // 다른 사람의 예매가 섞일 일이 없다(2026-08-07).
        tickets: [
          { id: held.id, quantity: 3, status: 'HELD', paymentStatus: null, isMine: true },
          { id: confirmed.id, quantity: 2, status: 'CONFIRMED', paymentStatus: 'PAID', isMine: true },
          { id: cancelled.id, quantity: 1, status: 'CANCELLED', paymentStatus: 'FAILED', isMine: true },
        ],
      });
    });
  });

  describe('게이트', () => {
    it('올바른 비번이면 type=demo 토큰을 발급한다(로그인 payload와 다른 모양)', async () => {
      const { demoToken } = await service.enterGate(TEST_GATE_PASSWORD);

      const jwt = moduleRef.get(JwtService);
      const payload = jwt.verify(demoToken);
      expect(payload.type).toBe('demo');
      expect(payload.sub).toBeUndefined(); // 로그인 JWT의 sub/email/role이 없다
    });

    it('틀린 비번이면 401을 던진다', async () => {
      await expect(service.enterGate('wrong-password')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('DEMO_GATE_PASSWORD가 설정 안 돼 있으면 어떤 비번을 넣어도 401이다', async () => {
      delete process.env.DEMO_GATE_PASSWORD;
      const config = moduleRef.get(ConfigService);
      expect(config.get('DEMO_GATE_PASSWORD')).toBeUndefined();

      await expect(
        service.enterGate(TEST_GATE_PASSWORD),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      process.env.DEMO_GATE_PASSWORD = TEST_GATE_PASSWORD; // 다음 테스트를 위해 복원
    });
  });
});
