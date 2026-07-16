import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 예매 — 비관적 락(pessimistic lock) 버전. (W2 락 3종 중 1번)
   *
   * 순진한 버전의 초과판매를 트랜잭션 + `SELECT … FOR UPDATE`로 막는다.
   * 재고 행을 잠그고 읽으면, 커밋 전까지 다른 예매(쓰기)는 그 행에서 줄 서서 대기한다.
   * → "내 읽기~쓰기 틈"에 남의 읽기가 못 들어오므로 낡은 값 기준 통과가 불가능.
   *
   * 흐름(전부 한 트랜잭션 안): ① 잠그고 읽기 → ② 확인 → ③ 차감 → ④ 기록.
   */
  async create(eventId: number, userId: number, quantity: number) {
    // $transaction(콜백) = 인터랙티브 트랜잭션. tx.* 호출은 모두 한 트랜잭션에서 실행되고,
    // 콜백이 정상 반환하면 커밋(락 해제), 예외를 던지면 롤백(락 해제)된다.
    return this.prisma.$transaction(async (tx) => {
      // ① 잠그고 읽는다. Prisma 쿼리빌더엔 FOR UPDATE가 없어 raw로 실행.
      //    태그드 템플릿의 ${eventId}는 Prisma가 파라미터로 바인딩(SQL 인젝션 방지).
      //    camelCase 컬럼은 Postgres에서 "쌍따옴표"로 감싸야 한다.
      const rows = await tx.$queryRaw<
        { id: number; remainingQty: number }[]
      >`SELECT id, "remainingQty" FROM inventories WHERE "eventId" = ${eventId} FOR UPDATE`;
      const inventory = rows[0];
      if (!inventory) {
        throw new NotFoundException('이벤트 재고를 찾을 수 없습니다.');
      }

      // ② 확인 — 이제 이 값은 락이 보장하는 "나만 보는 최신 값"이다
      if (inventory.remainingQty < quantity) {
        throw new ConflictException('재고가 부족합니다.');
      }

      // ★ 순진한 버전에서 버그를 100% 재현시켰던 그 지연을 일부러 남겨둔다.
      //   락이 이 넓은 틈에도 버티는지(=초과판매가 사라지는지) 확인하려는 것.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // ③ 차감 (같은 트랜잭션 tx로 — 그래야 락 안에서 처리됨)
      await tx.inventory.update({
        where: { id: inventory.id },
        data: { remainingQty: inventory.remainingQty - quantity },
      });

      // ④ 예매 기록
      return tx.reservation.create({
        data: { userId, eventId, quantity },
      });
    },
    // 락은 요청을 직렬화한다(줄 세움). 뒤 요청이 락을 기다리는 시간을 넉넉히 허용.
    //   maxWait: 트랜잭션 시작(커넥션 확보)까지 대기 한도, timeout: 트랜잭션 최대 수행시간.
    { maxWait: 20000, timeout: 20000 });
  }
}
