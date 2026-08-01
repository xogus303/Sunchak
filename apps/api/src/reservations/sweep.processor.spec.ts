import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ReservationStatus } from '@prisma/client';
import { SweepProcessor } from './sweep.processor';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SWEEP_QUEUE } from './reservations.constants';

// sweep의 핵심(원자적 UPDATE...RETURNING + Redis 보정)은 실제 DB·Redis가 있어야
// 의미 있게 검증된다. process()를 직접 호출해 반복 타이머(30초)를 기다리지 않는다.
describe('SweepProcessor (통합 — TTL 만료 스윕)', () => {
  let moduleRef: TestingModule;
  let processor: SweepProcessor;
  let prisma: PrismaService;
  let redis: RedisService;
  let queue: Queue;

  let userId: number;
  let eventId: number;

  const stockKey = () => `stock:event:${eventId}`;
  const seedStock = (qty: number) => redis.set(stockKey(), String(qty));
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
        BullModule.registerQueue({ name: SWEEP_QUEUE }),
      ],
      providers: [SweepProcessor, PrismaService, RedisService],
    }).compile();
    await moduleRef.init();

    processor = moduleRef.get(SweepProcessor);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);
    queue = moduleRef.get<Queue>(getQueueToken(SWEEP_QUEUE));
  });

  afterAll(async () => {
    // onModuleInit이 등록한 repeatable job까지 포함해 이 큐의 흔적을 지운다.
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.reservation.deleteMany();
    await prisma.inventory.deleteMany();
    await prisma.event.deleteMany();
    await prisma.user.deleteMany();

    const user = await prisma.user.create({
      data: { email: `sweep-${randomUUID()}@test.local`, password: 'x' },
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

  const createHeld = (quantity: number, heldUntil: Date) =>
    prisma.reservation.create({
      data: {
        userId,
        eventId,
        quantity,
        idempotencyKey: randomUUID(),
        status: ReservationStatus.HELD,
        heldUntil,
      },
    });

  it('heldUntil이 지난 HELD를 EXPIRED로 바꾸고 Redis 재고를 quantity만큼 돌려준다', async () => {
    await seedStock(3); // 5장 중 2장은 이미 관문 통과로 차감된 상태를 흉내
    const past = new Date(Date.now() - 1000);
    const reservation = await createHeld(2, past);

    await processor.process({} as Job);

    const updated = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(updated.status).toBe(ReservationStatus.EXPIRED);
    await expect(readStock()).resolves.toBe(5); // 3 + 2 = 5(원복)
  });

  it('heldUntil이 아직 안 지난 HELD는 건드리지 않는다', async () => {
    await seedStock(4);
    const future = new Date(Date.now() + 60_000);
    const reservation = await createHeld(1, future);

    await processor.process({} as Job);

    const untouched = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(untouched.status).toBe(ReservationStatus.HELD);
    await expect(readStock()).resolves.toBe(4); // 변화 없음
  });

  it('같은 이벤트의 만료 건이 여러 개면 합산해서 Redis를 한 번에 보정한다', async () => {
    await seedStock(2);
    const past = new Date(Date.now() - 1000);
    await createHeld(1, past);
    await createHeld(2, past);

    await processor.process({} as Job);

    await expect(readStock()).resolves.toBe(5); // 2 + (1+2) = 5
    const count = await prisma.reservation.count({
      where: { status: ReservationStatus.EXPIRED },
    });
    expect(count).toBe(2);
  });
});
