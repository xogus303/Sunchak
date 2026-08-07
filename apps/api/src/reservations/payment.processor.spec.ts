import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { PaymentStatus, ReservationStatus } from '@prisma/client';
import { PaymentProcessor } from './payment.processor';
import { ReservationEventsService } from './reservation-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CONFIRM_QUEUE } from './reservations.constants';

// 결제 성공/실패 판정 후의 동작(확정 큐 투입 / 재고 반환 + 상태 전환)은 실제
// DB·Redis가 있어야 의미 있게 검증된다 — sweep/reconcile과 같은 이유로
// process()를 직접 호출해 랜덤 판정만 스텁으로 고정한다.
describe('PaymentProcessor (통합 — 모의 결제 판정, ADR 0018)', () => {
  let moduleRef: TestingModule;
  let processor: PaymentProcessor;
  let prisma: PrismaService;
  let redis: RedisService;
  let randomSpy: jest.SpyInstance;

  let userId: number;
  let eventId: number;

  const stockKey = () => `stock:event:${eventId}`;
  const seedStock = (qty: number) => redis.set(stockKey(), String(qty));
  const readStock = async () => Number(await redis.get(stockKey()));

  const confirmQueueMock = { add: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        PaymentProcessor,
        ReservationEventsService,
        PrismaService,
        RedisService,
        { provide: getQueueToken(CONFIRM_QUEUE), useValue: confirmQueueMock },
      ],
    }).compile();
    await moduleRef.init();

    processor = moduleRef.get(PaymentProcessor);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.payment.deleteMany();
    await prisma.reservation.deleteMany();
    await prisma.inventory.deleteMany();
    await prisma.event.deleteMany();
    await prisma.user.deleteMany();
    confirmQueueMock.add.mockClear();

    const user = await prisma.user.create({
      data: { email: `pay-proc-${randomUUID()}@test.local`, password: 'x' },
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
    randomSpy?.mockRestore();
  });

  const createHeldWithPayment = async (quantity = 1) => {
    const reservation = await prisma.reservation.create({
      data: {
        userId,
        eventId,
        quantity,
        idempotencyKey: randomUUID(),
        status: ReservationStatus.HELD,
        heldUntil: new Date(Date.now() + 60_000),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        reservationId: reservation.id,
        amount: quantity * 10000,
        idempotencyKey: randomUUID(),
        status: PaymentStatus.PENDING,
      },
    });
    return { reservation, payment };
  };

  it('성공 판정이면 Payment를 PAID로 바꾸고 confirm 큐에 job을 넣는다(재고는 안 건드림)', async () => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.1); // < 0.8 → 성공
    await seedStock(3);
    const { reservation, payment } = await createHeldWithPayment(2);

    await processor.process({ data: { paymentId: payment.id, reservationId: reservation.id } } as Job);

    const updated = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(updated.status).toBe(PaymentStatus.PAID);
    expect(confirmQueueMock.add).toHaveBeenCalledWith('confirm', { reservationId: reservation.id });
    await expect(readStock()).resolves.toBe(3); // 관문 단계에서 이미 확정된 차감 — 성공 시 안 건드림
  });

  it('실패 판정이면 Payment를 FAILED, Reservation을 CANCELLED로 바꾸고 재고를 즉시 반환한다', async () => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9); // >= 0.8 → 실패
    await seedStock(3);
    const { reservation, payment } = await createHeldWithPayment(2);
    const events = moduleRef.get(ReservationEventsService);
    const received = firstValueFrom(events.ofReservation(reservation.id));

    await processor.process({ data: { paymentId: payment.id, reservationId: reservation.id } } as Job);

    const updatedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(updatedPayment.status).toBe(PaymentStatus.FAILED);
    const updatedReservation = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(updatedReservation.status).toBe(ReservationStatus.CANCELLED);
    await expect(readStock()).resolves.toBe(5); // 3 + 2(반환) = 5
    expect(confirmQueueMock.add).not.toHaveBeenCalled();
    await expect(received).resolves.toEqual({
      reservationId: reservation.id,
      status: ReservationStatus.CANCELLED,
    });
  });

  it('실패 판정인데 이미 HELD가 아니면(예: sweep이 먼저 회수) 재고를 또 돌려주지 않는다', async () => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9);
    await seedStock(5); // sweep이 이미 반환을 끝낸 상태를 흉내(재고 5 그대로)
    const { reservation, payment } = await createHeldWithPayment(2);
    // 결제 큐 처리 사이에 sweep이 먼저 만료 회수를 했다고 가정.
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: ReservationStatus.EXPIRED },
    });

    await processor.process({ data: { paymentId: payment.id, reservationId: reservation.id } } as Job);

    await expect(readStock()).resolves.toBe(5); // 이중 반환 안 됨
    const updatedReservation = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(updatedReservation.status).toBe(ReservationStatus.EXPIRED); // CANCELLED로 덮어쓰지 않음
  });
});
