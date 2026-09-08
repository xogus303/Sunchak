import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { ReservationStatus } from '@prisma/client';
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
 *   그대로 재사용 — 그 코드는 한 글자도 안 바뀐다). 단 그 전에 "지금도 여전히
 *   HELD인지"를 원자적으로 확인한다 — 실패 경로와 대칭. sweep이 이미 EXPIRED로
 *   회수한 뒤라면 PAID로 남기지 않고 FAILED로 처리한다(2026-09-01 발견·수정 —
 *   "Payment는 PAID인데 Reservation은 EXPIRED"인 정합성 불일치 방지).
 * - 실패: Payment→FAILED + Reservation을 CANCELLED로 돌리고 재고를 즉시 반환한다
 *   (사용자 확인 후 채택 — TTL 만료를 기다리지 않음). 그 사이 sweep이 먼저
 *   EXPIRED로 회수했다면(드문 경합) 여기서 중복 반환하지 않는다.
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
 * - job당 DB 왕복 횟수 축소(2026-09-05) — 원래 각 분기가 "HELD 재확인/취소"와
 *   "Payment 상태 갱신"을 순차적인 별도 Prisma 호출 2~3번으로 나눠 했는데,
 *   Neon(원격 DB) 왕복 1번이 약 100ms라 job 하나가 250~300ms씩 걸려 처리량이
 *   낮았다(실측 초당 약 70건, ADR 0023). 사용자 지적("동시 요청이 많든 적든
 *   결제 처리 자체가 느려선 안 된다") — 큐 경합이 아니라 job당 지연 자체를
 *   줄여야 처리량이 실제로 오른다. 두 분기 모두 원자적 확인+갱신을 raw SQL
 *   한 문장(성공: UPDATE...FROM...RETURNING, 실패: CTE로 묶은 이중 UPDATE)으로
 *   합쳐 왕복을 1번으로 줄인다(sweep.processor.ts와 같은 패턴 — Prisma의
 *   updateMany는 RETURNING을 지원하지 않아 원시 SQL이 필요).
 *
 *   ⚠️ 버그였다가 수정(2026-09-09) — `$queryRaw`는 Prisma Client의 자동
 *   `@updatedAt` 갱신을 안 거친다(그건 `prisma.model.update()` 같은 클라이언트
 *   API에서만 동작하는 기능). 위 최적화로 바꾸며 이걸 놓쳐서, `updatedAt`이
 *   실제 처리 시각이 아니라 row 생성 시각에 영원히 멈춰있는 버그가 생겼다 —
 *   실제 서비스 동작(재고·정합성)엔 영향 없지만(이 필드를 읽는 비즈니스
 *   로직 없음), 관측/디버깅용 타임스탬프를 신뢰할 수 없게 만들었다. 실제로
 *   이 버그 때문에 "결제가 즉시 처리된다"는 잘못된 진단을 한 번 내린 뒤,
 *   사용자의 브라우저 캡처(실측 40초+)와 안 맞아 뒤늦게 발견했다 — 이제
 *   두 raw SQL 모두 `"updatedAt" = now()`를 명시적으로 같이 갱신한다.
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
      // "지금도 여전히 HELD인지" 확인과 "그 결과에 따라 Payment를 PAID/FAILED로
      // 갱신"을 한 왕복으로 합친다 — sweep의 UPDATE...WHERE status='HELD'와
      // 같은 행을 두고 경합해도 둘 중 하나만 이긴다(WHERE 조건 자체가 방어선).
      const [row] = await this.prisma.$queryRaw<{ wasHeld: boolean }[]>`
        UPDATE payments
        SET status = CASE WHEN r.status = 'HELD' THEN 'PAID'::"PaymentStatus" ELSE 'FAILED'::"PaymentStatus" END,
          "updatedAt" = now()
        FROM reservations r
        WHERE payments.id = ${paymentId} AND payments."reservationId" = r.id
        RETURNING (r.status = 'HELD') AS "wasHeld"
      `;
      if (!row.wasHeld) {
        // sweep이 먼저 EXPIRED로 회수함 — 결제를 PAID로 남기면 "Payment는
        // PAID인데 Reservation은 EXPIRED"인 거짓 데이터가 생긴다. 재고는
        // sweep이 이미 반환했으므로 여기서 또 건드리지 않는다.
        return;
      }
      await this.confirmQueue.add('confirm', { reservationId });
      return;
    }

    // 실패 분기 — "HELD면 CANCELLED로 갱신", "Payment를 FAILED로 갱신", "반환할
    // 재고량 조회" 세 단계를 CTE 하나로 합친다. reservations 갱신이 0건이면
    // (예: sweep이 먼저 회수) eventId/quantity가 NULL로 돌아와 재고 반환을 건너뛴다.
    const [row] = await this.prisma.$queryRaw<
      { eventId: number | null; quantity: number | null }[]
    >`
      WITH cancelled AS (
        UPDATE reservations
        SET status = 'CANCELLED', "updatedAt" = now()
        WHERE id = ${reservationId} AND status = 'HELD'
        RETURNING "eventId", quantity
      )
      UPDATE payments
      SET status = 'FAILED', "updatedAt" = now()
      WHERE id = ${paymentId}
      RETURNING
        (SELECT "eventId" FROM cancelled) AS "eventId",
        (SELECT quantity FROM cancelled) AS quantity
    `;

    if (row.eventId === null) {
      // 이미 HELD가 아님(예: sweep이 먼저 만료 회수) — 재고를 또 돌려주면 이중 반환이라 건너뛴다.
      return;
    }

    await this.redis.incrby(`stock:event:${row.eventId}`, row.quantity!);
    this.events.publish({ reservationId, status: ReservationStatus.CANCELLED });
  }
}
