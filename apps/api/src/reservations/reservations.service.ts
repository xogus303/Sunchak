import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

// W2 동시성 비교용 — 예매 재고 차감을 처리하는 5가지 전략.
// + W3 최종 흐름(held): 관문(DECRBY) + HELD 선기록 + 멱등성 보상.
export type ReservationStrategy =
  | 'naive' // 방어 없음(초과판매 남) — '빠르지만 틀린' 기준선
  | 'pessimistic' // 비관적 락(FOR UPDATE + 트랜잭션)
  | 'optimistic' // 낙관적 락(version compare-and-swap + 재시도)
  | 'atomic' // DB 원자연산(조건부 단일 UPDATE)
  | 'redis' // Redis 인메모리 원자 차감(DECRBY + 넘치면 보상)
  | 'held'; // W3 최종 흐름 — 관문 통과 후 status=HELD로 선기록 + 재전송 멱등 처리

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // 낙관적 락 재시도 상한.
  private readonly MAX_RETRIES = 5;

  /**
   * 예매 진입점 — strategy에 따라 각 구현으로 분기한다.
   * naive~redis는 W2 벤치마크 비교용, held는 W3 최종 흐름의 진입부다.
   * idempotencyKey는 held에서만 쓰는 클라이언트 발급 이름표(그 외 전략은 무시).
   */
  create(
    eventId: number,
    userId: number,
    quantity: number,
    strategy: ReservationStrategy = 'atomic',
    idempotencyKey?: string,
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
      case 'redis':
        return this.createRedis(eventId, userId, quantity);
      case 'held':
        return this.createHeld(eventId, userId, quantity, idempotencyKey);
      default:
        throw new BadRequestException(`알 수 없는 strategy: ${String(strategy)}`);
    }
  }

  // W2 5전략(naive~redis)은 멱등성이 목적이 아니다. idempotencyKey는 NOT NULL을
  // 만족시키고 (userId, idempotencyKey) unique 충돌을 피하기 위해 서버가 임의 발급한다.
  // (같은 유저가 수만 건 만드는 벤치에서도 매번 새 UUID라 충돌하지 않음.)

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
      data: { userId, eventId, quantity, idempotencyKey: randomUUID() },
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
        return tx.reservation.create({
          data: { userId, eventId, quantity, idempotencyKey: randomUUID() },
        });
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
        data: { userId, eventId, quantity, idempotencyKey: randomUUID() },
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
      data: { userId, eventId, quantity, idempotencyKey: randomUUID() },
    });
  }

  // ── 5) Redis 원자 차감 ───────────────────────────────────────
  // 경합이 심한 "재고 확인+차감"을 DB가 아닌 Redis 인메모리 카운터에서 처리한다.
  // DECRBY는 단일 스레드라 그 자체로 원자적 → lost update가 없다.
  // 단, DECRBY엔 "재고 부족" 조건이 없어 0 밑으로도 깎인다.
  //   → 반환값(차감 후 값)이 음수면 초과이므로, INCRBY로 되돌리고(보상) 409.
  //   → 음수가 아니면 유효한 티켓 확보 → 예매 기록만 DB에 남긴다.
  // 재고 카운터의 초깃값(seed)은 벤치 스크립트가 이벤트 생성 직후 Redis에 심는다.
  private async createRedis(eventId: number, userId: number, quantity: number) {
    const key = `stock:event:${eventId}`;
    const remaining = await this.redis.decrby(key, quantity);
    if (remaining < 0) {
      // 방금 잘못 깎은 만큼 정확히 되돌린다(재고가 -로 새는 것 방지).
      await this.redis.incrby(key, quantity);
      throw new ConflictException('재고가 부족합니다.');
    }
    return this.prisma.reservation.create({
      data: { userId, eventId, quantity, idempotencyKey: randomUUID() },
    });
  }

  // ── 6) HELD 선기록 (W3 최종 흐름의 진입부) ──────────────────────
  // Redis 관문(DECRBY)으로 티켓을 확보한 즉시 DB에 status=HELD로 '선기록'한다.
  // (다음 단계에서 큐 워커가 HELD→CONFIRMED로 확정하고 SSE로 알림 — 아직 미구현.)
  //
  // 멱등성: 클라이언트가 발급한 idempotencyKey로 재전송을 식별한다.
  //   - 관문이 INSERT보다 먼저라, 재전송도 DECRBY를 한 번 더 깎는다.
  //   - HELD INSERT가 (userId, idempotencyKey) unique를 위반하면(P2002) = 재전송.
  //     → 깎은 재고를 INCRBY로 되돌리고(보상), 첫 요청의 예매를 그대로 성공 응답한다(409 아님).
  private async createHeld(
    eventId: number,
    userId: number,
    quantity: number,
    idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('idempotencyKey가 필요합니다.');
    }

    const key = `stock:event:${eventId}`;
    const remaining = await this.redis.decrby(key, quantity);
    if (remaining < 0) {
      await this.redis.incrby(key, quantity); // 초과분 되돌리기
      throw new ConflictException('재고가 부족합니다.');
    }

    try {
      return await this.prisma.reservation.create({
        data: {
          userId,
          eventId,
          quantity,
          idempotencyKey,
          status: ReservationStatus.HELD,
        },
      });
    } catch (e) {
      // 재전송(같은 userId+idempotencyKey의 2번째 INSERT) → DB가 원자적으로 거부.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        await this.redis.incrby(key, quantity); // 재전송이 깎은 재고 보상
        return this.prisma.reservation.findUniqueOrThrow({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });
      }
      throw e;
    }
  }
}
