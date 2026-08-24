import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BadRequestException, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoadTestService } from './load-test.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { QueueEventsService } from '../queue/queue-events.service';
import { EventsService } from '../events/events.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PaymentsService } from '../reservations/payments.service';
import { LOAD_TEST_ACTIVE_QUEUES_KEY } from '../queue/queue.constants';

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
});
