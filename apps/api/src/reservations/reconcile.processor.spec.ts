import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ReservationStatus } from '@prisma/client';
import { ReconcileProcessor } from './reconcile.processor';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  HELD_ACTIVITY_KEY,
  HELD_ACTIVITY_TTL_MS,
  RECONCILE_FALLBACK_KEY,
  RECONCILE_QUEUE,
} from './reservations.constants';

// '총재고 − (HELD+CONFIRMED)'가 핵심이라 실제 DB가 있어야 의미 있게 검증된다.
// process()를 직접 호출해 반복 타이머(1분)를 기다리지 않는다.
describe('ReconcileProcessor (통합 — Redis 재고 재구성)', () => {
  let moduleRef: TestingModule;
  let processor: ReconcileProcessor;
  let prisma: PrismaService;
  let redis: RedisService;

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
  });

  afterAll(async () => {
    // sweep.processor.spec.ts와 같은 이유로 obliterate()를 안 쓴다 — 같은 Redis에
    // 개발 서버가 떠 있으면 그 서버의 반복 job 스케줄까지 지워버린다(2026-08-06 발견).
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.payment.deleteMany(); // Payment→Reservation FK를 먼저 지워야 아래 delete가 성공한다(ADR 0018)
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

    // ADR 0021 — reconcile이 이제 이 플래그를 보고 Postgres 접근 여부를
    // 판단한다. 이 스펙은 재계산 로직 자체(스킵 여부가 아니라)를 검증하는
    // 게 목적이라, 모든 테스트를 "방금 활동이 있었던" 상태로 시작시킨다.
    await redis.del(HELD_ACTIVITY_KEY, RECONCILE_FALLBACK_KEY);
    await redis.set(HELD_ACTIVITY_KEY, '1', 'PX', HELD_ACTIVITY_TTL_MS);
  });

  afterEach(async () => {
    await redis.del(stockKey(), HELD_ACTIVITY_KEY, RECONCILE_FALLBACK_KEY);
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

  // ADR 0021 — 활동 플래그가 없을 때의 스킵/보험 로직 자체를 검증.
  // beforeEach가 세워둔 활동 플래그를 각 테스트 시작 시 다시 지워
  // "활동 신호가 없는 상태"를 재현한다.
  it('활동 플래그가 없고 보험 주기도 아직이면 Postgres를 건드리지 않는다', async () => {
    await redis.del(HELD_ACTIVITY_KEY);
    await redis.set(stockKey(), '999'); // 어긋난 값(정상이면 reconcile이 고쳐야 함)
    await createReservation(1, ReservationStatus.HELD);
    // 보험을 이미 써버린 상태를 흉내.
    await redis.set(RECONCILE_FALLBACK_KEY, '1', 'PX', 24 * 60 * 60 * 1000);

    await processor.process({} as Job);

    await expect(readStock()).resolves.toBe(999); // 안 고침 — Postgres 자체를 안 감
  });

  it('활동 플래그가 없어도 보험 주기가 지났으면 Postgres를 확인한다', async () => {
    await redis.del(HELD_ACTIVITY_KEY);
    await redis.set(stockKey(), '999');
    await createReservation(1, ReservationStatus.HELD);
    // RECONCILE_FALLBACK_KEY를 안 세팅 = "보험 주기가 지났다"와 동일한 상태.

    await processor.process({} as Job);

    await expect(readStock()).resolves.toBe(4); // 5 − 1 = 4, 보험으로 정상 보정됨
  });
});
