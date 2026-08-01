import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SWEEP_INTERVAL_MS, SWEEP_QUEUE } from './reservations.constants';

interface ExpiredRow {
  id: number;
  eventId: number;
  quantity: number;
}

/**
 * TTL 만료 스윕 — HELD인데 heldUntil이 지난 예매를 주기적으로 회수한다. (W3 2.5)
 *
 * - 트리거가 confirm처럼 '사건'이 아니라 '시간 자체'라 BullMQ repeatable job으로 돈다.
 *   (delayed job을 예매마다 하나씩 쓰지 않는 이유: 트래픽이 몰릴 때 다수가 같은 순간
 *   만료돼 워커 동시성만큼 밀린다 — 반면 벌크 UPDATE 1번은 건수와 무관하게 일정하다.)
 * - UPDATE...RETURNING 한 문장으로 '대상 찾기'와 '상태 변경'을 원자적으로 합친다.
 *   (SELECT 후 UPDATE로 나누면 그 사이 confirm 워커가 같은 행을 먼저 채갈 수 있다 —
 *   WHERE status='HELD' 조건 자체가 그 경합을 막는 방어선이다. Prisma updateMany는
 *   RETURNING을 지원하지 않아 원시 SQL이 필요하다.)
 * - DB 업데이트가 끝난 뒤에만 Redis를 보정한다(순서 중요). 크래시가 그 사이에 나도
 *   DB는 이미 EXPIRED라 뒤늦은 confirm job은 WHERE status=HELD에 안 걸려 무시된다
 *   (초과판매 방지). Redis만 못 돌려준 상태는 재구성 잡(reconcile)이 결국 고친다.
 */
@Processor(SWEEP_QUEUE)
export class SweepProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SweepProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @InjectQueue(SWEEP_QUEUE) private readonly sweepQueue: Queue,
  ) {
    super();
  }

  // confirm과 달리 이 큐는 외부에서 add하지 않는다 — 앱이 뜰 때 자기 자신을
  // 반복 등록한다. 같은 repeat 설정이면 BullMQ가 중복 스케줄러를 만들지 않는다.
  async onModuleInit() {
    await this.sweepQueue.add(
      'sweep',
      {},
      { repeat: { every: SWEEP_INTERVAL_MS } },
    );
  }

  async process(_job: Job): Promise<void> {
    const expired = await this.prisma.$queryRaw<ExpiredRow[]>`
      UPDATE reservations
      SET status = 'EXPIRED'
      WHERE status = 'HELD' AND "heldUntil" < now()
      RETURNING id, "eventId", quantity
    `;

    if (expired.length === 0) {
      return;
    }

    // 여러 건이 같은 이벤트일 수 있으니 이벤트별로 합쳐서 Redis 호출을 줄인다.
    const qtyByEvent = new Map<number, number>();
    for (const row of expired) {
      qtyByEvent.set(row.eventId, (qtyByEvent.get(row.eventId) ?? 0) + row.quantity);
    }

    for (const [eventId, qty] of qtyByEvent) {
      await this.redis.incrby(`stock:event:${eventId}`, qty);
    }

    this.logger.debug(
      `TTL 만료 회수: ${expired.length}건, 이벤트 ${qtyByEvent.size}개 재고 복구`,
    );
  }
}
