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
 *   그대로 재사용 — 그 코드는 한 글자도 안 바뀐다). 단 그 전에 `updateMany
 *   (WHERE status=HELD, data: 같은 HELD로 재기록)`로 "지금도 여전히 HELD인지"를
 *   원자적으로 확인한다 — 실패 경로와 대칭. sweep이 이미 EXPIRED로 회수한
 *   뒤라면(count===0) PAID로 남기지 않고 FAILED로 처리한다(2026-09-01 발견·
 *   수정 — "Payment는 PAID인데 Reservation은 EXPIRED"인 정합성 불일치 방지).
 * - 실패: Payment→FAILED + Reservation을 CANCELLED로 돌리고 재고를 즉시 반환한다
 *   (사용자 확인 후 채택 — TTL 만료를 기다리지 않음). `updateMany(WHERE status=HELD)`
 *   가드로, 그 사이 sweep이 먼저 EXPIRED로 회수했다면(드문 경합) 여기서 중복 반환하지 않는다.
 *
 * - concurrency(2026-08-31 발견·수정) — BullMQ Worker의 기본값은 1이라, job을
 *   한 번에 딱 하나씩만 처리한다. 대용량 테스트로 5,000명이 동시에 결제를
 *   시도하면 DB 커넥션 풀(connection_limit=20)을 넉넉히 늘려도 워커 자체가
 *   줄을 세워 처리해 job 하나가 처리되기까지 수 분씩 걸렸고(실측 3분 34초),
 *   그 사이 HELD 30초 TTL이 먼저 지나 sweep에 회수돼버려 위 정합성 불일치를
 *   낳았다. 커넥션 풀 크기와 맞춰 최대 20개 job을 동시에 처리하도록 올린다.
 * - 근본 수정(2026-09-01, ADR 0023): admission 자체가 결제 파이프라인의 실제
 *   처리량을 넘지 않게 백프레셔를 걸어(`load-test-admission.processor.ts`)
 *   이 경합이 애초에 드물게 일어나도록 했다. 이 파일의 HELD 가드는 그래도
 *   남을 수 있는 잔여 경합에 대한 정합성 방어선이다 — concurrency·백프레셔가
 *   "얼마나 자주" 겪는지를 줄이고, 이 가드는 "겪었을 때 거짓 데이터가 안
 *   남게" 보장한다. 역할이 다르다.
 */
@Processor(PAYMENT_QUEUE, { concurrency: 20 })
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
      // 데이터를 안 바꾸는 값(HELD→HELD)으로 updateMany를 걸어 "지금도 여전히
      // HELD인지"를 원자적으로 확인+잠근다 — sweep의 UPDATE...WHERE status=HELD와
      // 같은 행을 두고 경합해도 둘 중 하나만 이긴다.
      const { count } = await this.prisma.reservation.updateMany({
        where: { id: reservationId, status: ReservationStatus.HELD },
        data: { status: ReservationStatus.HELD },
      });
      if (count === 0) {
        // sweep이 먼저 EXPIRED로 회수함 — 결제를 PAID로 남기면 "Payment는
        // PAID인데 Reservation은 EXPIRED"인 거짓 데이터가 생긴다. 재고는
        // sweep이 이미 반환했으므로 여기서 또 건드리지 않는다.
        await this.prisma.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.FAILED },
        });
        return;
      }

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
