import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PaymentStatus, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ReservationEventsService } from './reservation-events.service';
import { CONFIRM_QUEUE, PAYMENT_QUEUE } from './reservations.constants';

interface PayJobData {
  paymentId: number;
  reservationId: number;
}

/**
 * 모의 결제 판정 워커(ADR 0018) — "결제하기" 요청이 큐에 들어오면 여기서 성공/실패를
 * 굴린다. 실제 PG 연동이 아니라 학습용 모의라 확률로 판정한다.
 *
 * - 성공: Payment→PAID, 기존 'confirm' 큐에 job만 투입한다(ConfirmProcessor를
 *   그대로 재사용 — 그 코드는 한 글자도 안 바뀐다).
 * - 실패: Payment→FAILED + Reservation을 CANCELLED로 돌리고 재고를 즉시 반환한다
 *   (사용자 확인 후 채택 — TTL 만료를 기다리지 않음). `updateMany(WHERE status=HELD)`
 *   가드로, 그 사이 sweep이 먼저 EXPIRED로 회수했다면(드문 경합) 여기서 중복 반환하지 않는다.
 */
@Processor(PAYMENT_QUEUE)
export class PaymentProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: ReservationEventsService,
    @InjectQueue(CONFIRM_QUEUE) private readonly confirmQueue: Queue,
  ) {
    super();
  }

  private readonly SUCCESS_RATE = 0.8;

  async process(job: Job<PayJobData>): Promise<void> {
    const { paymentId, reservationId } = job.data;
    const succeeded = Math.random() < this.SUCCESS_RATE;

    if (succeeded) {
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.PAID },
      });
      await this.confirmQueue.add('confirm', { reservationId });
      return;
    }

    const { count } = await this.prisma.reservation.updateMany({
      where: { id: reservationId, status: ReservationStatus.HELD },
      data: { status: ReservationStatus.CANCELLED },
    });
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.FAILED },
    });

    if (count === 0) {
      // 이미 HELD가 아님(예: sweep이 먼저 만료 회수) — 재고를 또 돌려주면 이중 반환이라 건너뛴다.
      return;
    }

    const reservation = await this.prisma.reservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    await this.redis.incrby(`stock:event:${reservation.eventId}`, reservation.quantity);
    this.events.publish({ reservationId, status: ReservationStatus.CANCELLED });
  }
}
