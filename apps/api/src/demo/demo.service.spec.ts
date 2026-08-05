import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventStatus, ReservationStatus } from '@prisma/client';
import { DemoService } from './demo.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ReservationsService } from '../reservations/reservations.service';

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
  const readStock = async () => Number(await redis.get(stockKey()));

  // 실제 파이프라인(큐·워커)까지는 이 스펙의 관심사가 아니다 — 시뮬레이션이
  // ReservationsService.create를 '호출하는지'만 확인하면 되므로 스텁으로 대체.
  const reservationsCreateMock = jest.fn().mockResolvedValue({});

  beforeAll(async () => {
    process.env.DEMO_GATE_PASSWORD = TEST_GATE_PASSWORD; // ConfigModule 로드 전에 세팅
    process.env.DEMO_SIM_MAX_VU = '10';
    process.env.DEMO_SIM_COOLDOWN_MS = '60000';
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({ secret: 'test-secret' }),
      ],
      providers: [
        DemoService,
        PrismaService,
        RedisService,
        { provide: ReservationsService, useValue: { create: reservationsCreateMock } },
      ],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(DemoService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    delete process.env.DEMO_GATE_PASSWORD; // 다른 스펙 파일에 안 새게 정리
    delete process.env.DEMO_SIM_MAX_VU;
    delete process.env.DEMO_SIM_COOLDOWN_MS;
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.reservation.deleteMany();
    await prisma.inventory.deleteMany();
    await prisma.event.deleteMany();
    await prisma.user.deleteMany();
    reservationsCreateMock.mockClear();

    const user = await prisma.user.create({
      data: { email: `demo-${randomUUID()}@test.local`, password: 'x' },
    });
    userId = user.id;
  });

  afterEach(async () => {
    if (eventId) await redis.del(stockKey());
    await redis.del(SIM_COOLDOWN_KEY); // 다음 테스트에 쿨다운 잠금이 새지 않게
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

  describe('시뮬레이션 (축 B-1)', () => {
    it('가상 유저 수가 상한(DEMO_SIM_MAX_VU)을 넘으면 400을 던진다', async () => {
      await expect(service.simulateLoad(11)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(reservationsCreateMock).not.toHaveBeenCalled();
    });

    it('정상 요청이면 즉시 accepted를 반환하고, 백그라운드에서 가상 유저를 실제로 투입한다', async () => {
      const event = await createDemoEvent(10);
      eventId = event.id;

      const result = await service.simulateLoad(1);
      expect(result).toEqual({ accepted: 1 });

      await new Promise((res) => setTimeout(res, 300)); // 백그라운드 투입 여유

      expect(reservationsCreateMock).toHaveBeenCalledWith(
        event.id,
        expect.any(Number),
        1,
        'held',
        expect.any(String),
      );
      const simUsers = await prisma.user.findMany({
        where: { email: { startsWith: 'sim-' } },
      });
      expect(simUsers).toHaveLength(1);
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
