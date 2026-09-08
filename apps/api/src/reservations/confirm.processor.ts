import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationEventsService } from './reservation-events.service';
import { CONFIRM_QUEUE } from './reservations.constants';

// job 페이로드 — 예매 내용 전체가 아니라 '가리키는 포인터'(id)만 담는다.
// 요청 시점의 스냅샷을 믿지 않고, 처리 시점의 진짜 상태는 워커가 DB에서 직접 읽는다.
interface ConfirmJobData {
  reservationId: number;
}

/**
 * 확정 워커 — HELD 예매를 CONFIRMED로 뒤집는다. (W3 파이프라인 ⑤)
 *
 * - @Processor(CONFIRM_QUEUE): 이 클래스를 'confirm' 큐의 소비자로 등록한다.
 *   WorkerHost를 상속하면 process()가 job 하나를 처리하는 콜백이 된다.
 * - 멱등성: updateMany({ where: status=HELD })라 이미 CONFIRMED/EXPIRED면 0건.
 *   → 같은 job이 재시도되거나 중복 투입돼도 안전(본래 멱등). 별도 방어 불필요.
 * - 재시도: process()가 throw하면 BullMQ가 job을 다시 큐에 넣는다(attempts/backoff).
 *   그래서 인프라 오류만 throw하고, count===0(할 일 없음)은 정상 종료한다.
 *
 * - concurrency(2026-08-31, payment.processor.ts와 같은 이유): 결제 성공마다
 *   이 큐에도 job이 하나씩 더 쌓이므로, payment 큐만 올리면 병목이 여기로
 *   그대로 넘어온다. 같은 값(20)으로 맞춘다.
 * - raw SQL(2026-09-09) — `updateMany()`(Prisma Client)는 매 호출을 암묵적
 *   BEGIN...COMMIT으로 감싼다(Prisma의 기본 안전장치, 왕복 3번). 대용량
 *   테스트로 pg_stat_activity를 직접 관측해보니 이 워커가 `reservations.
 *   service.ts`의 예매 생성과 함께 커넥션 풀(20개)을 "idle in transaction"
 *   상태로 가장 많이 묶어두는 두 곳이었다(20개 중 최대 15개가 이 상태로 관측됨).
 *   `$queryRaw`는 이 래핑을 안 거쳐 왕복이 1번으로 준다(payment.processor.ts와
 *   같은 패턴).
 */
@Processor(CONFIRM_QUEUE, { concurrency: 20 })
export class ConfirmProcessor extends WorkerHost {
  private readonly logger = new Logger(ConfirmProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ReservationEventsService,
  ) {
    super();
  }

  async process(job: Job<ConfirmJobData>): Promise<void> {
    const { reservationId } = job.data;

    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      UPDATE reservations
      SET status = 'CONFIRMED', "updatedAt" = now()
      WHERE id = ${reservationId} AND status = 'HELD'
      RETURNING id
    `;

    if (rows.length === 0) {
      // 이미 CONFIRMED(재시도·중복 job)거나 EXPIRED(TTL 회수됨) → 확정할 게 없음.
      this.logger.debug(`예매 ${reservationId}: HELD 아님 → 확정 건너뜀(멱등 no-op)`);
      return;
    }

    // '진짜로 이번에 확정된' 경우에만 방송한다(count>0). 중복 job·이미 확정은
    // 위에서 걸러졌으므로 여기까지 오면 상태가 방금 HELD→CONFIRMED로 바뀐 것이다.
    // → SSE로 열려 대기 중인 클라이언트에게 이 방송이 흘러간다.
    this.events.publish({
      reservationId,
      status: ReservationStatus.CONFIRMED,
    });
  }
}
