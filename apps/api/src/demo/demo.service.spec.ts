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

const TEST_GATE_PASSWORD = 'sunchak-test';
const SIM_COOLDOWN_KEY = 'demo:sim:cooldown';

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
    await redis.del(SIM_COOLDOWN_KEY); // 다음 테스트에 쿨다운 잠금이 새지 않게
    if (eventId) {
      await redis.del(`queue:event:${eventId}`);
      await redis.srem(ACTIVE_QUEUES_KEY, String(eventId));
    }
  });

  const createDemoEvent = (totalQty: number) =>
    prisma.event.create({
      data: {
        title: '테스트 데모 이벤트',
        price: 10000,
        openAt: new Date('2020-01-01T00:00:00.000Z'), // 과거 — 리셋이 갱신하는지 확인용
        status: EventStatus.SOLD_OUT, // 리셋이 ON_SALE로 되돌리는지 확인용
        isDemo: true,
        inventory: { create: { totalQty, remainingQty: 0 } },
      },
      include: { inventory: true },
    });

  it('데모 이벤트가 없으면 404를 던진다', async () => {
    await expect(service.resetDemoEvent()).rejects.toBeInstanceOf(
      NotFoundException,
    );
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

    const result = await service.resetDemoEvent();

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

    await expect(service.resetDemoEvent()).resolves.toBeDefined(); // 던지지 않아야 함(P2003 재발 방지)

    await expect(prisma.payment.count()).resolves.toBe(0);
    await expect(prisma.reservation.count()).resolves.toBe(0);
  });

  it('openAt을 현재로, status를 ON_SALE로 되돌린다', async () => {
    const event = await createDemoEvent(5);
    eventId = event.id;

    const before = Date.now();
    const result = await service.resetDemoEvent();

    expect(result.event.status).toBe(EventStatus.ON_SALE);
    expect(result.event.openAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('isDemo가 아닌 이벤트는 리셋 대상에서 제외한다', async () => {
    const other = await prisma.event.create({
      data: {
        title: '수동 테스트용 이벤트(데모 아님)',
        price: 5000,
        openAt: new Date(),
        isDemo: false,
        inventory: { create: { totalQty: 20, remainingQty: 20 } },
      },
    });

    await expect(service.resetDemoEvent()).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const untouched = await prisma.inventory.findUniqueOrThrow({
      where: { eventId: other.id },
    });
    expect(untouched.remainingQty).toBe(20); // 손대지 않음
  });

  it('시뮬레이션이 만든 sim- 접두사 유저는 지우고, 일반 유저는 남긴다', async () => {
    const event = await createDemoEvent(10);
    eventId = event.id;
    await prisma.user.create({
      data: { email: `sim-${randomUUID()}@sunchak.demo`, password: null },
    });

    await service.resetDemoEvent();

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

    await service.resetDemoEvent();

    await expect(queueService.status(eventId, userId)).resolves.toEqual({
      rank: null,
      admitted: false,
    });
    await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(0);
  });

  describe('시뮬레이션 (축 B-1)', () => {
    it('가상 유저 수가 상한(DEMO_SIM_MAX_VU)을 넘으면 400을 던진다', async () => {
      await expect(service.simulateLoad(11)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(reservationsCreateMock).not.toHaveBeenCalled();
    });

    it('정상 요청이면 즉시 accepted를 반환하고, 대기열을 거쳐 백그라운드에서 가상 유저를 실제로 투입한다', async () => {
      const event = await createDemoEvent(10);
      eventId = event.id;

      const result = await service.simulateLoad(1);
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

      await service.simulateLoad(1);
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

      await service.simulateLoad(1);
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

      await service.simulateLoad(1);
      await expect(service.simulateLoad(1)).rejects.toBeInstanceOf(
        HttpException,
      );
    });
  });

  describe('stats 대시보드 (축 B-2)', () => {
    it('데모 이벤트가 없으면 404를 던진다', async () => {
      await expect(service.streamStats()).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('재고·HELD/CONFIRMED 합계·큐 적체·결제 성공/실패·재고소진·포기 집계를 스냅샷으로 흘려보낸다', async () => {
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

      const msg = await firstValueFrom(await service.streamStats());

      expect(msg.data).toEqual({
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
