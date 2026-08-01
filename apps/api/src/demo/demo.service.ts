import { Injectable, NotFoundException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * 공개 데모 모드(ADR 0016)의 데이터 리셋 — seed와 수동 리셋 엔드포인트가
 * 이 로직을 공유한다. 리셋 대상은 `isDemo=true`인 단 하나의 이벤트뿐이다
 * (로컬 개발 중 수동으로 만든 다른 이벤트와 섞이지 않게 명시적으로 식별).
 */
@Injectable()
export class DemoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async resetDemoEvent() {
    const event = await this.prisma.event.findFirst({
      where: { isDemo: true },
      include: { inventory: true },
    });
    if (!event || !event.inventory) {
      throw new NotFoundException(
        '데모 이벤트가 없습니다 — seed(prisma db seed)를 먼저 실행하세요.',
      );
    }

    // 예매를 지워야 재고가 실제로 원복된다(HELD/CONFIRMED가 남아있으면 재구성
    // 잡(reconcile)이 다음 틱에 다시 깎아버림 — 순서가 아니라 삭제 자체가 핵심).
    await this.prisma.reservation.deleteMany({ where: { eventId: event.id } });

    const inventory = await this.prisma.inventory.update({
      where: { eventId: event.id },
      data: {
        remainingQty: event.inventory.totalQty,
        version: { increment: 1 }, // 낙관적 락(W2) 전략과의 충돌 방지
      },
    });

    await this.redis.set(`stock:event:${event.id}`, inventory.remainingQty);

    const updatedEvent = await this.prisma.event.update({
      where: { id: event.id },
      data: { openAt: new Date(), status: EventStatus.ON_SALE },
    });

    return { event: updatedEvent, inventory };
  }
}
