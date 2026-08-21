import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ReservationStatus } from '@prisma/client';
import { SweepProcessor } from './sweep.processor';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  HELD_ACTIVITY_KEY,
  HELD_ACTIVITY_TTL_MS,
  SWEEP_FALLBACK_KEY,
  SWEEP_QUEUE,
} from './reservations.constants';

// sweep의 핵심(원자적 UPDATE...RETURNING + Redis 보정)은 실제 DB·Redis가 있어야
// 의미 있게 검증된다. process()를 직접 호출해 반복 타이머(30초)를 기다리지 않는다.
describe('SweepProcessor (통합 — TTL 만료 스윕)', () => {
  let moduleRef: TestingModule;
  let processor: SweepProcessor;
  let prisma: PrismaService;
  let redis: RedisService;

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
  });

  afterAll(async () => {
    // ⚠️ 예전엔 여기서 queue.obliterate({force:true})로 정리했는데, 같은 Redis에
    // 개발 서버가 떠 있으면 그 서버가 등록한 반복 job 스케줄까지 통째로 지워버렸다
    // (같은 큐 이름을 공유하므로 테스트 것과 서버 것이 사실상 같은 등록). 반복
    // 스케줄이 남아있어도 무해하니(서버가 죽어있으면 아무도 안 쓰는 데이터일 뿐,
    // 살아있으면 그 서버에 필요한 데이터) 그냥 연결만 닫는다.
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.payment.deleteMany(); // Payment→Reservation FK를 먼저 지워야 아래 delete가 성공한다(ADR 0018)
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

    // ADR 0021 — sweep이 이제 이 플래그를 보고 Postgres 접근 여부를 판단한다.
    // 매 테스트를 "방금 활동이 있었던" 상태로 깨끗하게 시작시킨다(다른 스펙
    // 파일이나 백그라운드 워커의 잔여 상태에 의존하지 않기 위해 먼저 지운다).
    await redis.del(HELD_ACTIVITY_KEY, SWEEP_FALLBACK_KEY);
  });

  afterEach(async () => {
    await redis.del(stockKey(), HELD_ACTIVITY_KEY, SWEEP_FALLBACK_KEY);
  });

  // 실제로는 ReservationsService.createHeld()가 DB 기록과 함께 이 플래그를
  // 세운다 — 테스트 헬퍼는 서비스를 안 거치고 DB에 직접 꽂으므로 그 신호도
  // 직접 흉내 낸다(안 그러면 sweep이 "활동 없음"으로 판단해 건너뛴다).
  const createHeld = async (quantity: number, heldUntil: Date) => {
    const reservation = await prisma.reservation.create({
      data: {
        userId,
        eventId,
        quantity,
        idempotencyKey: randomUUID(),
        status: ReservationStatus.HELD,
        heldUntil,
      },
    });
    await redis.set(HELD_ACTIVITY_KEY, '1', 'PX', HELD_ACTIVITY_TTL_MS);
    return reservation;
  };

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

  // ADR 0021 — 활동 플래그가 없을 때의 스킵/보험 로직 자체를 검증. 아래 두
  // 테스트는 createHeld 헬퍼(플래그를 자동으로 세움)를 안 쓰고 DB에 직접
  // 꽂아서, "활동 신호가 없는 상태"를 정확히 재현한다.
  it('활동 플래그가 없고 보험 주기도 아직이면 Postgres를 건드리지 않는다', async () => {
    await seedStock(3);
    const past = new Date(Date.now() - 1000);
    const reservation = await prisma.reservation.create({
      data: {
        userId,
        eventId,
        quantity: 2,
        idempotencyKey: randomUUID(),
        status: ReservationStatus.HELD,
        heldUntil: past,
      },
    });
    // 보험을 이미 써버린 상태를 흉내(방금 막 한 번 돈 것처럼).
    await redis.set(SWEEP_FALLBACK_KEY, '1', 'PX', 24 * 60 * 60 * 1000);

    await processor.process({} as Job);

    const untouched = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(untouched.status).toBe(ReservationStatus.HELD); // 건드리지 않음
    await expect(readStock()).resolves.toBe(3); // 변화 없음
  });

  it('활동 플래그가 없어도 보험 주기가 지났으면 Postgres를 확인한다', async () => {
    await seedStock(3);
    const past = new Date(Date.now() - 1000);
    const reservation = await prisma.reservation.create({
      data: {
        userId,
        eventId,
        quantity: 2,
        idempotencyKey: randomUUID(),
        status: ReservationStatus.HELD,
        heldUntil: past,
      },
    });
    // SWEEP_FALLBACK_KEY를 안 세팅 = "보험 주기가 지났다"와 동일한 상태.

    await processor.process({} as Job);

    const updated = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(updated.status).toBe(ReservationStatus.EXPIRED); // 보험으로 잡힘
    await expect(readStock()).resolves.toBe(5); // 3 + 2 = 5
  });
});
