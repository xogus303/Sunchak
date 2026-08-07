import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PaymentStatus } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { ReservationsService } from './reservations.service';
import { ReservationEventsService } from './reservation-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PAYMENT_QUEUE } from './reservations.constants';

// 결제 요청 접수(PaymentsService)는 '실제' DB의 reservationId unique 제약이
// 재전송 방어의 핵심이라 mock으로는 검증이 무의미하다 — 통합 테스트로 짠다.
// ReservationsService는 큐 의존성이 없어(ADR 0018로 confirm 큐 주입이 빠짐)
// mock 없이 실제 인스턴스를 그대로 쓴다(assertOwned 재사용 검증까지 겸함).
describe('PaymentsService (통합 — 결제 접수, ADR 0018)', () => {
  let moduleRef: TestingModule;
  let service: PaymentsService;
  let prisma: PrismaService;

  let userId: number;
  let otherUserId: number;
  let eventId: number;
  let eventPrice: number;

  const paymentQueueMock = { add: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        PaymentsService,
        ReservationsService,
        ReservationEventsService,
        PrismaService,
        RedisService,
        { provide: getQueueToken(PAYMENT_QUEUE), useValue: paymentQueueMock },
      ],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(PaymentsService);
    prisma = moduleRef.get(PrismaService);
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
    paymentQueueMock.add.mockClear();

    const user = await prisma.user.create({
      data: { email: `pay-${randomUUID()}@test.local`, password: 'x' },
    });
    userId = user.id;
    const other = await prisma.user.create({
      data: { email: `pay-other-${randomUUID()}@test.local`, password: 'x' },
    });
    otherUserId = other.id;

    eventPrice = 10000;
    const event = await prisma.event.create({
      data: {
        title: '테스트 콘서트',
        price: eventPrice,
        openAt: new Date('2026-08-01T10:00:00.000Z'),
        inventory: { create: { totalQty: 5, remainingQty: 5 } },
      },
    });
    eventId = event.id;
  });

  const createHeldReservation = (quantity = 2) =>
    prisma.reservation.create({
      data: {
        userId,
        eventId,
        quantity,
        idempotencyKey: randomUUID(),
        status: 'HELD',
        heldUntil: new Date(Date.now() + 60_000),
      },
    });

  it('HELD 예매에 결제를 요청하면 PENDING Payment를 만들고 결제 큐에 job을 넣는다', async () => {
    const reservation = await createHeldReservation(2);

    const payment = await service.pay(reservation.id, userId, randomUUID());

    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.amount).toBe(2 * eventPrice); // 수량 × 가격
    expect(paymentQueueMock.add).toHaveBeenCalledWith('pay', {
      paymentId: payment.id,
      reservationId: reservation.id,
    });
  });

  it('본인 예매가 아니면 결제를 거부한다', async () => {
    const reservation = await createHeldReservation();

    await expect(
      service.pay(reservation.id, otherUserId, randomUUID()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(paymentQueueMock.add).not.toHaveBeenCalled();
  });

  it('HELD가 아닌 예매(이미 확정/취소됨)는 결제할 수 없다', async () => {
    const reservation = await prisma.reservation.create({
      data: {
        userId,
        eventId,
        quantity: 1,
        idempotencyKey: randomUUID(),
        status: 'CONFIRMED',
      },
    });

    await expect(service.pay(reservation.id, userId, randomUUID())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(paymentQueueMock.add).not.toHaveBeenCalled();
  });

  it('같은 예매에 결제 요청이 재전송돼도 새 Payment를 만들지 않고 기존 것을 그대로 반환한다', async () => {
    const reservation = await createHeldReservation();

    const first = await service.pay(reservation.id, userId, randomUUID());
    const second = await service.pay(reservation.id, userId, randomUUID()); // 다른 idempotencyKey라도

    expect(second.id).toBe(first.id);
    await expect(prisma.payment.count()).resolves.toBe(1);
    expect(paymentQueueMock.add).toHaveBeenCalledTimes(1); // 재전송은 큐에 또 안 넣음
  });
});
