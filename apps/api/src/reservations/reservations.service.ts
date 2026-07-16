import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 예매 — DB 원자연산(atomic conditional update) 버전. (W2 락 3종 중 3번)
   *
   * 앱에서 읽지 않는다. "재고가 충분할 때만 차감"을 단 하나의 UPDATE 문장에 담는다.
   * DB가 이 한 문장을 원자적으로(그 순간 행 락) 처리하므로 read-check-write 틈 자체가 없다.
   * → 트랜잭션도, version도, 재시도 루프도 필요 없음. 셋 중 가장 단순.
   *
   * 흐름: ① 조건부 차감(1문장) → 0행이면 매진, 1행이면 ② 기록.
   */
  async create(eventId: number, userId: number, quantity: number) {
    // ① 조건부 원자 차감. WHERE의 remainingQty>=quantity 조건과 decrement가 한 문장에서 평가/적용된다.
    //    updateMany → { count }. eventId는 @unique라 대상 행은 0개 또는 1개.
    //    (지연은 뒀자 무의미 — 앱 쪽에 벌릴 '틈'이 없다. 그래서 이 버전엔 setTimeout 없음.)
    const result = await this.prisma.inventory.updateMany({
      where: { eventId, remainingQty: { gte: quantity } },
      data: { remainingQty: { decrement: quantity } },
    });

    // count===0 = 조건 불만족(재고 부족) 또는 그런 eventId 없음. 순수 1문장이라 둘을 구분하려면
    // 추가 조회가 필요해 여기선 하나로 묶어 409로 처리(단순함 우선 — 이 방식의 트레이드오프).
    if (result.count === 0) {
      throw new ConflictException('재고가 부족합니다.');
    }

    // ② 예매 기록
    return this.prisma.reservation.create({
      data: { userId, eventId, quantity },
    });
  }
}
