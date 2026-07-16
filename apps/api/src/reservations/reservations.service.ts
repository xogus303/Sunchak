import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  // 낙관적 락 재시도 상한 — 충돌로 실패하면 다시 읽고 재시도. 이만큼 다 실패하면 포기.
  private readonly MAX_RETRIES = 5;

  /**
   * 예매 — 낙관적 락(optimistic lock) 버전. (W2 락 3종 중 2번)
   *
   * 락을 아예 잡지 않고 읽는다. 대신 차감을 "version이 그대로일 때만" 적용되는
   * 단일 조건부 UPDATE로 하고(= compare-and-swap), 그 사이 누가 바꿔 0행이면 충돌로 보고 재시도.
   * → 비관적 락과 달리 대기(줄 서기)가 없다. 대신 경합이 심하면 재시도 비용이 든다.
   *
   * 흐름: ① 락 없이 읽기 → ② 확인 → ③ version 조건부 UPDATE → 0행이면 재시도, 1행이면 ④ 기록.
   */
  async create(eventId: number, userId: number, quantity: number) {
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      // ① 락 없이 그냥 읽는다 (version과 현재 재고 확보)
      const inventory = await this.prisma.inventory.findUnique({
        where: { eventId },
      });
      if (!inventory) {
        throw new NotFoundException('이벤트 재고를 찾을 수 없습니다.');
      }

      // ② 확인 — 이미 매진이면 재시도 무의미, 바로 거절
      if (inventory.remainingQty < quantity) {
        throw new ConflictException('재고가 부족합니다.');
      }

      // ★ 재현용 지연 — 충돌 창을 벌린다(많은 요청이 같은 version을 읽게).
      await new Promise((resolve) => setTimeout(resolve, 50));

      // ③ 조건부 UPDATE — "내가 읽은 그 version 그대로일 때만" 차감.
      //    updateMany는 결과로 { count }를 준다(unique 아닌 where 허용). count===0 = 그 사이 누가 바꿈.
      //    version 가드가 있으니 remainingQty 절대값 덮어쓰기도 안전(값이 안 바뀐 게 보장됨).
      const result = await this.prisma.inventory.updateMany({
        where: { id: inventory.id, version: inventory.version },
        data: {
          remainingQty: inventory.remainingQty - quantity,
          version: { increment: 1 }, // 성공 시 version을 올려 다음 사람의 조건을 어긋나게 함
        },
      });

      if (result.count === 0) {
        // 충돌 — 누가 먼저 차감(version 변경). 처음부터 다시.
        continue;
      }

      // ④ 성공 → 예매 기록
      return this.prisma.reservation.create({
        data: { userId, eventId, quantity },
      });
    }

    // 재시도를 다 소진 — 지금 경합이 너무 심함. 잠시 후 재시도 유도.
    throw new ConflictException('예매 요청이 몰려 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  }
}
