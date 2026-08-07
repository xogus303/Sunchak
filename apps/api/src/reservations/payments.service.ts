import { ConflictException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma, PaymentStatus, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from './reservations.service';
import { PAYMENT_QUEUE } from './reservations.constants';

/**
 * 모의 결제(ADR 0018) — "결제하기" 클릭이 실제로 들어오는 창구.
 * 결제 자체의 성공/실패 판정은 여기서 하지 않는다(PaymentProcessor의 몫) —
 * 이 서비스는 결제 요청을 접수해 큐에 넘기기만 한다(비동기, PRD가 명시한 방식).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationsService,
    @InjectQueue(PAYMENT_QUEUE) private readonly paymentQueue: Queue,
  ) {}

  async pay(reservationId: number, userId: number, idempotencyKey: string) {
    // 남의 예매에 결제를 걸 수 없게 소유권부터 확인(SSE와 같은 원칙 재사용).
    await this.reservations.assertOwned(reservationId, userId);

    const reservation = await this.prisma.reservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: { event: true },
    });
    if (reservation.status !== ReservationStatus.HELD) {
      throw new ConflictException(
        '결제할 수 없는 상태입니다(이미 처리됐거나 만료됨).',
      );
    }

    try {
      const payment = await this.prisma.payment.create({
        data: {
          reservationId,
          amount: reservation.quantity * reservation.event.price,
          idempotencyKey,
          status: PaymentStatus.PENDING,
        },
      });
      await this.paymentQueue.add('pay', { paymentId: payment.id, reservationId });
      return payment;
    } catch (e) {
      // 재전송(같은 예매에 결제 요청 재시도) — Payment.reservationId가 이미
      // @unique(1:1)라 그걸로 원자적으로 잡힌다. 새 큐 job을 또 넣지 않고
      // 기존 결제 상태를 그대로 반환한다(몇 번을 호출하든 결과가 같다).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.prisma.payment.findUniqueOrThrow({ where: { reservationId } });
      }
      throw e;
    }
  }
}
