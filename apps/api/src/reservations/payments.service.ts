import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_QUEUE } from './reservations.constants';

interface PayQueryRow {
  targetId: number | null;
  targetUserId: number | null;
  targetStatus: string | null;
  paymentId: number | null;
  paymentReservationId: number | null;
  paymentAmount: number | null;
  paymentStatus: PaymentStatus | null;
  paymentIdempotencyKey: string | null;
  paymentCreatedAt: Date | null;
  paymentUpdatedAt: Date | null;
}

/**
 * 모의 결제(ADR 0018) — "결제하기" 클릭이 실제로 들어오는 창구.
 * 결제 자체의 성공/실패 판정은 여기서 하지 않는다(PaymentProcessor의 몫) —
 * 이 서비스는 결제 요청을 접수해 큐에 넘기기만 한다(비동기, PRD가 명시한 방식).
 *
 * raw SQL 단일 왕복(2026-09-09) — 원래 "소유권 확인 → 예매+이벤트 재조회 →
 * Payment 생성" 세 번의 순차 Prisma 호출이었다. 대용량 테스트로 실측(pay()를
 * 800명이 동시 호출)해보니, 평범할 땐 300~450ms면 끝날 이 호출이 커넥션 풀
 * (20개) 경합 때문에 p50 2.8초·p90 3.9초까지 늘어졌다 — payment.processor.ts가
 * 2026-09-05에 겪은 것과 같은 병목이 프론트도어(pay() 자체)에도 그대로
 * 남아있던 것. "확인"(소유권+상태)과 "쓰기"(Payment 생성)를 CTE 하나로 묶어
 * 왕복을 1번으로 줄인다 — 왕복 수가 3분의 1이 되므로, 같은 인원이 몰려도
 * 각자가 커넥션을 붙잡는 시간이 그만큼 줄어 실질 처리 능력이 늘어난다.
 *
 * 에러 케이스 판별 — 한 왕복으로 합치며 "없음(404)/본인 것 아님(403)/HELD
 * 아님(409)"을 구분해야 하는데, `target` CTE(예매+이벤트 조회)는 소유권·상태와
 * 무관하게 항상 조회하고, `ins` CTE(Payment 생성)는 소유권+상태가 맞을 때만
 * 실행되게 해서 두 CTE의 결과를 한 행으로 합쳐 반환한다 — 애플리케이션 코드가
 * `targetId`(존재 여부)·`targetUserId`(소유자)·`paymentId`(생성 성공 여부)
 * 세 값만 보고 세 에러를 그대로 구분할 수 있다.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(PAYMENT_QUEUE) private readonly paymentQueue: Queue,
  ) {}

  async pay(reservationId: number, userId: number, idempotencyKey: string) {
    let row: PayQueryRow;
    try {
      [row] = await this.prisma.$queryRaw<PayQueryRow[]>`
        WITH target AS (
          SELECT r.id, r."userId", r.status, r.quantity, e.price
          FROM reservations r
          JOIN events e ON e.id = r."eventId"
          WHERE r.id = ${reservationId}
        ),
        ins AS (
          INSERT INTO payments ("reservationId", amount, "idempotencyKey", status, "createdAt", "updatedAt")
          SELECT t.id, t.quantity * t.price, ${idempotencyKey}, 'PENDING'::"PaymentStatus", now(), now()
          FROM target t
          WHERE t."userId" = ${userId} AND t.status = 'HELD'::"ReservationStatus"
          RETURNING *
        )
        SELECT
          (SELECT id FROM target) AS "targetId",
          (SELECT "userId" FROM target) AS "targetUserId",
          (SELECT status FROM target) AS "targetStatus",
          (SELECT id FROM ins) AS "paymentId",
          (SELECT "reservationId" FROM ins) AS "paymentReservationId",
          (SELECT amount FROM ins) AS "paymentAmount",
          (SELECT status FROM ins) AS "paymentStatus",
          (SELECT "idempotencyKey" FROM ins) AS "paymentIdempotencyKey",
          (SELECT "createdAt" FROM ins) AS "paymentCreatedAt",
          (SELECT "updatedAt" FROM ins) AS "paymentUpdatedAt"
      `;
    } catch (e) {
      // 재전송(같은 예매에 결제 요청 재시도) — Payment.reservationId가 이미
      // @unique(1:1)라 그걸로 원자적으로 잡힌다. 새 큐 job을 또 넣지 않고
      // 기존 결제 상태를 그대로 반환한다(몇 번을 호출하든 결과가 같다).
      // ⚠️ raw SQL 에러는 항상 최상위 code가 'P2010'으로 오고 실제 DB 에러
      // 코드(unique violation='23505')는 e.meta.code에 담긴다(createHeld()와
      // 같은 패턴, reservations.service.ts 주석 참고).
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2010' &&
        (e.meta as { code?: string } | undefined)?.code === '23505'
      ) {
        return this.prisma.payment.findUniqueOrThrow({ where: { reservationId } });
      }
      throw e;
    }

    if (row.targetId === null) {
      throw new NotFoundException('예매를 찾을 수 없습니다.');
    }
    if (row.targetUserId !== userId) {
      throw new ForbiddenException('본인의 예매만 결제할 수 있습니다.');
    }
    if (row.paymentId === null) {
      throw new ConflictException(
        '결제할 수 없는 상태입니다(이미 처리됐거나 만료됨).',
      );
    }

    await this.paymentQueue.add('pay', { paymentId: row.paymentId, reservationId });
    return {
      id: row.paymentId,
      reservationId: row.paymentReservationId,
      amount: row.paymentAmount,
      status: row.paymentStatus,
      idempotencyKey: row.paymentIdempotencyKey,
      createdAt: row.paymentCreatedAt,
      updatedAt: row.paymentUpdatedAt,
    };
  }
}
