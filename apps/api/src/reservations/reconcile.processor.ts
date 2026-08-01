import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RECONCILE_INTERVAL_MS, RECONCILE_QUEUE } from './reservations.constants';

/**
 * Redis 재고 재구성 — remaining = 총재고 − (HELD + CONFIRMED)를 주기적으로 다시
 * 계산해 Redis에 덮어쓴다. (W3 2.5, ADR 0015)
 *
 * DB와 Redis는 별개 저장소라 하나의 트랜잭션으로 묶을 수 없다(dual-write 문제).
 * Redis가 죽었다 살아나는 큰 사고뿐 아니라, sweep처럼 'DB 먼저 쓰고 Redis는
 * 나중에' 두 단계로 나뉜 작업이 그 사이에 끊겨도 작은 어긋남이 남는다 — 그래서
 * '한 번'이 아니라 '상시 주기적으로' 돈다. 방향은 항상 안전한 쪽(Redis가 실제보다
 * 적게 보여줄 순 있어도 많이 보여주진 않음)이라 그 사이 거짓 품절은 나도 초과판매는 안 난다.
 *
 * DB가 source of truth이므로 상대 연산(INCRBY/DECRBY)이 아니라 절대값 SET으로
 * 덮어쓴다 — 계산해낸 값이 곧 정답이지, 기존 Redis 값에 더하거나 뺄 이유가 없다.
 */
@Processor(RECONCILE_QUEUE)
export class ReconcileProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @InjectQueue(RECONCILE_QUEUE) private readonly reconcileQueue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    await this.reconcileQueue.add(
      'reconcile',
      {},
      { repeat: { every: RECONCILE_INTERVAL_MS } },
    );
  }

  async process(_job: Job): Promise<void> {
    const inventories = await this.prisma.inventory.findMany({
      select: { eventId: true, totalQty: true },
    });
    if (inventories.length === 0) {
      return;
    }

    const held = await this.prisma.reservation.groupBy({
      by: ['eventId'],
      where: {
        status: { in: [ReservationStatus.HELD, ReservationStatus.CONFIRMED] },
      },
      _sum: { quantity: true },
    });
    const heldByEvent = new Map(
      held.map((h) => [h.eventId, h._sum.quantity ?? 0]),
    );

    for (const inv of inventories) {
      const remaining = inv.totalQty - (heldByEvent.get(inv.eventId) ?? 0);
      await this.redis.set(`stock:event:${inv.eventId}`, remaining);
    }
  }
}
