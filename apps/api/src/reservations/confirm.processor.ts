import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
 */
@Processor(CONFIRM_QUEUE)
export class ConfirmProcessor extends WorkerHost {
  private readonly logger = new Logger(ConfirmProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<ConfirmJobData>): Promise<void> {
    const { reservationId } = job.data;

    const { count } = await this.prisma.reservation.updateMany({
      where: { id: reservationId, status: ReservationStatus.HELD },
      data: { status: ReservationStatus.CONFIRMED },
    });

    if (count === 0) {
      // 이미 CONFIRMED(재시도·중복 job)거나 EXPIRED(TTL 회수됨) → 확정할 게 없음.
      this.logger.debug(`예매 ${reservationId}: HELD 아님 → 확정 건너뜀(멱등 no-op)`);
    }
  }
}
