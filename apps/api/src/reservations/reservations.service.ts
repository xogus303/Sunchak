import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// W2 동시성 비교용 — 예매 재고 차감을 처리하는 4가지 전략.
export type ReservationStrategy =
  | 'naive' // 방어 없음(초과판매 남) — '빠르지만 틀린' 기준선
  | 'pessimistic' // 비관적 락(FOR UPDATE + 트랜잭션)
  | 'optimistic' // 낙관적 락(version compare-and-swap + 재시도)
  | 'atomic'; // DB 원자연산(조건부 단일 UPDATE)

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  // 낙관적 락 재시도 상한.
  private readonly MAX_RETRIES = 5;

  /**
   * 예매 진입점 — strategy에 따라 4가지 구현으로 분기한다(W2 벤치마크 비교용).
   * 실서비스라면 한 전략만 두겠지만, k6로 처리량을 비교하려고 런타임 선택을 허용한다.
   */
  create(
    eventId: number,
    userId: number,
    quantity: number,
    strategy: ReservationStrategy = 'atomic',
  ) {
    switch (strategy) {
      case 'naive':
        return this.createNaive(eventId, userId, quantity);
      case 'pessimistic':
        return this.createPessimistic(eventId, userId, quantity);
      case 'optimistic':
        return this.createOptimistic(eventId, userId, quantity);
      case 'atomic':
        return this.createAtomic(eventId, userId, quantity);
      default:
        throw new BadRequestException(`알 수 없는 strategy: ${String(strategy)}`);
    }
  }

  // ── 1) 순진한 버전 ────────────────────────────────────────────
  // ①읽기 →②확인 →③절대값 덮어쓰기 →④기록. 읽기·쓰기가 별개 문장이라 그 틈에
  // 다른 요청이 낡은 값을 읽고 통과 → 초과판매(lost update). 벤치마크의 기준선.
  private async createNaive(eventId: number, userId: number, quantity: number) {
    const inventory = await this.prisma.inventory.findUnique({
      where: { eventId },
    });
    if (!inventory) {
      throw new NotFoundException('이벤트 재고를 찾을 수 없습니다.');
    }
    if (inventory.remainingQty < quantity) {
      throw new ConflictException('재고가 부족합니다.');
    }
    await this.prisma.inventory.update({
      where: { id: inventory.id },
      data: { remainingQty: inventory.remainingQty - quantity },
    });
    return this.prisma.reservation.create({
      data: { userId, eventId, quantity },
    });
  }

  // ── 2) 비관적 락 ─────────────────────────────────────────────
  // 트랜잭션 안에서 FOR UPDATE로 재고 행을 잠그고 읽어, 커밋 전까지 다른 예매를 대기시킴.
  private async createPessimistic(
    eventId: number,
    userId: number,
    quantity: number,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: number; remainingQty: number }[]
        >`SELECT id, "remainingQty" FROM inventories WHERE "eventId" = ${eventId} FOR UPDATE`;
        const inventory = rows[0];
        if (!inventory) {
          throw new NotFoundException('이벤트 재고를 찾을 수 없습니다.');
        }
        if (inventory.remainingQty < quantity) {
          throw new ConflictException('재고가 부족합니다.');
        }
        await tx.inventory.update({
          where: { id: inventory.id },
          data: { remainingQty: inventory.remainingQty - quantity },
        });
        return tx.reservation.create({ data: { userId, eventId, quantity } });
      },
      { maxWait: 20000, timeout: 20000 },
    );
  }

  // ── 3) 낙관적 락 ─────────────────────────────────────────────
  // 락 없이 version+재고를 읽고, "version이 그대로일 때만" 차감(compare-and-swap).
  // 그 사이 누가 바꿔 0행이면 충돌로 보고 재시도.
  private async createOptimistic(
    eventId: number,
    userId: number,
    quantity: number,
  ) {
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      const inventory = await this.prisma.inventory.findUnique({
        where: { eventId },
      });
      if (!inventory) {
        throw new NotFoundException('이벤트 재고를 찾을 수 없습니다.');
      }
      if (inventory.remainingQty < quantity) {
        throw new ConflictException('재고가 부족합니다.');
      }
      const result = await this.prisma.inventory.updateMany({
        where: { id: inventory.id, version: inventory.version },
        data: {
          remainingQty: inventory.remainingQty - quantity,
          version: { increment: 1 },
        },
      });
      if (result.count === 0) {
        continue; // 충돌 → 재시도
      }
      return this.prisma.reservation.create({
        data: { userId, eventId, quantity },
      });
    }
    throw new ConflictException(
      '예매 요청이 몰려 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.',
    );
  }

  // ── 4) DB 원자연산 ───────────────────────────────────────────
  // "재고가 충분할 때만 차감"을 단일 UPDATE로. 앱에서 읽지 않아 read-check-write 틈이 없음.
  private async createAtomic(
    eventId: number,
    userId: number,
    quantity: number,
  ) {
    const result = await this.prisma.inventory.updateMany({
      where: { eventId, remainingQty: { gte: quantity } },
      data: { remainingQty: { decrement: quantity } },
    });
    if (result.count === 0) {
      throw new ConflictException('재고가 부족합니다.');
    }
    return this.prisma.reservation.create({
      data: { userId, eventId, quantity },
    });
  }
}
