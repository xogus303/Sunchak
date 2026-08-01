import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ReservationStatus } from '@prisma/client';
import { ReconcileProcessor } from './reconcile.processor';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RECONCILE_QUEUE } from './reservations.constants';

// '총재고 − (HELD+CONFIRMED)'가 핵심이라 실제 DB가 있어야 의미 있게 검증된다.
// process()를 직접 호출해 반복 타이머(1분)를 기다리지 않는다.
describe('ReconcileProcessor (통합 — Redis 재고 재구성)', () => {
  let moduleRef: TestingModule;
  let processor: ReconcileProcessor;
  let prisma: PrismaService;
  let redis: RedisService;
  let queue: Queue;

  let userId: number;
  let eventId: number;

  const stockKey = () => `stock:event:${eventId}`;
  const readStock = async () => Number(await redis.get(stockKey()));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            const url = new URL(
              config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
            );
            return { connection: { host: url.hostname, port: Number(url.port) || 6379 } };
          },
        }),
        BullModule.registerQueue({ name: RECONCILE_QUEUE }),
      ],
      providers: [ReconcileProcessor, PrismaService, RedisService],
    }).compile();
    await moduleRef.init();

    processor = moduleRef.get(ReconcileProcessor);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);
    queue = moduleRef.get<Queue>(getQueueToken(RECONCILE_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.reservation.deleteMany();
    await prisma.inventory.deleteMany();
    await prisma.event.deleteMany();
    await prisma.user.deleteMany();

    const user = await prisma.user.create({
      data: { email: `reconcile-${randomUUID()}@test.local`, password: 'x' },
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
    await redis.del(stockKey());
  });

  const createReservation = (quantity: number, status: ReservationStatus) =>
    prisma.reservation.create({
      data: {
        userId,
        eventId,
        quantity,
        idempotencyKey: randomUUID(),
        status,
        heldUntil: status === ReservationStatus.HELD ? new Date(Date.now() + 60_000) : null,
      },
    });

  it('Redis가 비어있어도(유실 시뮬레이션) DB 기준으로 정확한 값을 SET한다', async () => {
    await redis.del(stockKey()); // Redis flush를 흉내(키 자체가 없음)
    await createReservation(2, ReservationStatus.HELD);
    await createReservation(1, ReservationStatus.CONFIRMED);

    await processor.process({} as Job);

    await expect(readStock()).resolves.toBe(2); // 5 − (2+1) = 2
  });

  it('Redis 값이 잘못돼 있어도(드리프트) 절대값으로 덮어써 바로잡는다', async () => {
    await redis.set(stockKey(), '999'); // 어긋난 값
    await createReservation(1, ReservationStatus.HELD);

    await processor.process({} as Job);

    await expect(readStock()).resolves.toBe(4); // 5 − 1 = 4 (999는 무시하고 덮어씀)
  });

  it('HELD/CONFIRMED가 없는 이벤트는 총재고 그대로 SET한다', async () => {
    await redis.del(stockKey());

    await processor.process({} as Job);

    await expect(readStock()).resolves.toBe(5);
  });

  it('EXPIRED·CANCELLED는 계산에서 제외한다', async () => {
    await redis.del(stockKey());
    await createReservation(3, ReservationStatus.EXPIRED);
    await createReservation(2, ReservationStatus.CANCELLED);
    await createReservation(1, ReservationStatus.CONFIRMED);

    await processor.process({} as Job);

    await expect(readStock()).resolves.toBe(4); // 5 − 1(EXPIRED·CANCELLED는 안 셈)
  });
});
