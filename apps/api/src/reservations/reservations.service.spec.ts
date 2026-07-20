import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ReservationsService } from './reservations.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

// held 흐름은 '실제' DB의 unique 제약(P2002)과 '실제' Redis DECRBY 원자성이 핵심이라
// mock으로는 검증이 무의미하다. 로컬 Postgres/Redis에 붙는 통합 테스트로 짠다.
// (사전조건: infra/docker-compose의 postgres·redis 기동 + apps/api/.env 로드)
describe('ReservationsService (통합 — held 흐름)', () => {
  let moduleRef: TestingModule;
  let service: ReservationsService;
  let prisma: PrismaService;
  let redis: RedisService;

  let userId: number;
  let eventId: number;

  const stockKey = () => `stock:event:${eventId}`;
  // 관문 재고 카운터를 Redis에 심는 헬퍼
  const seedStock = (qty: number) => redis.set(stockKey(), String(qty));
  const readStock = async () => Number(await redis.get(stockKey()));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [ReservationsService, PrismaService, RedisService],
    }).compile();
    await moduleRef.init(); // onModuleInit 실행 → Prisma/Redis 연결

    service = moduleRef.get(ReservationsService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    await moduleRef.close(); // onModuleDestroy → 연결 정리
  });

  // 각 테스트는 깨끗한 user·event·inventory(재고 5)에서 시작한다.
  beforeEach(async () => {
    await prisma.reservation.deleteMany();
    await prisma.inventory.deleteMany();
    await prisma.event.deleteMany();
    await prisma.user.deleteMany();

    const user = await prisma.user.create({
      data: { email: `held-${randomUUID()}@test.local`, password: 'x' },
    });
    userId = user.id;

    const event = await prisma.event.create({
      data: {
        title: '테스트 콘서트',
        price: 10000,
        openAt: new Date('2026-08-01T10:00:00.000Z'),
        inventory: { create: { totalQty: 5, remainingQty: 5 } },
      },
    });
    eventId = event.id;
  });

  afterEach(async () => {
    await redis.del(stockKey()); // 남은 재고 카운터 정리(테스트 간 격리)
  });

  describe('정상 예매', () => {
    it('관문 통과 시 status=HELD 예매 1건을 만들고 Redis 재고를 quantity만큼 깎는다', async () => {
      await seedStock(5);

      const reservation = await service.create(
        eventId,
        userId,
        1,
        'held',
        randomUUID(),
      );

      expect(reservation.status).toBe('HELD');
      await expect(prisma.reservation.count()).resolves.toBe(1);
      await expect(readStock()).resolves.toBe(4); // 5 → 4
    });
  });

  describe('재전송(같은 idempotencyKey 2회)', () => {
    it('예매는 1건만 유지되고 Redis 재고는 딱 1만 깎인다(2번 차감 후 1번 보상)', async () => {
      await seedStock(5);
      const key = randomUUID();

      const first = await service.create(eventId, userId, 1, 'held', key);
      const second = await service.create(eventId, userId, 1, 'held', key);

      expect(second.id).toBe(first.id); // 첫 예매를 그대로 돌려줌
      await expect(prisma.reservation.count()).resolves.toBe(1); // 중복 INSERT 없음
      await expect(readStock()).resolves.toBe(4); // 두 번 깎였다가 보상 → 순감소 1
    });
  });

  describe('재고 부족(초과판매 방지)', () => {
    it('DECRBY가 음수가 되면 409를 던지고 Redis 재고를 원복한다', async () => {
      await seedStock(0);

      await expect(
        service.create(eventId, userId, 1, 'held', randomUUID()),
      ).rejects.toBeInstanceOf(ConflictException);

      await expect(readStock()).resolves.toBe(0); // -1로 갔다가 보상으로 0 복구
      await expect(prisma.reservation.count()).resolves.toBe(0); // 예매 생성 안 됨
    });
  });

  describe('멱등성 키 누락', () => {
    it('held인데 idempotencyKey가 없으면 400을 던진다', async () => {
      await seedStock(5);

      await expect(
        service.create(eventId, userId, 1, 'held'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
