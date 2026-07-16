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
   * ⚠️ 순진한(naive) 예매 — W2 학습용. 일부러 아무 동시성 방어가 없다.
   * 재고 1개에 동시 요청이 몰리면 초과판매(oversell)가 난다. 이 버그를 재현한 뒤 고칠 것.
   *
   * 흐름: ① 재고 읽기 → ② 남았는지 확인 → ③ 재고 차감 → ④ 예매 기록.
   * 급소: ①읽기와 ③쓰기 사이의 틈에 다른 요청이 끼어들면 ②확인이 낡은 값 기준이 된다.
   */
  async create(eventId: number, userId: number, quantity: number) {
    // ① 재고를 읽는다 (이 순간의 스냅샷 — 곧 낡을 수 있는 값)
    const inventory = await this.prisma.inventory.findUnique({
      where: { eventId },
    });
    if (!inventory) {
      throw new NotFoundException('이벤트 재고를 찾을 수 없습니다.');
    }

    // ② 남았는지 확인한다 — ①에서 읽은 과거 값 기준이라 이미 위태롭다
    if (inventory.remainingQty < quantity) {
      throw new ConflictException('재고가 부족합니다.');
    }

    // ★ [W2 재현용] race window를 인위적으로 벌린다. 이 요청을 50ms 재우는 동안
    //   다른 동시 요청들이 ①읽기를 끝내고 같은 낡은 값으로 ②를 통과한다.
    //   (실서비스 코드 아님 — 초과판매를 100% 재현해 보여주려는 학습용 지연.)
    await new Promise((resolve) => setTimeout(resolve, 50));

    // ③ 재고를 깎는다 — 앱이 계산한 절대값으로 덮어쓴다(가장 순진한 방식).
    //    다른 요청의 차감이 여기서 통째로 사라질 수 있다(lost update).
    await this.prisma.inventory.update({
      where: { id: inventory.id },
      data: { remainingQty: inventory.remainingQty - quantity },
    });

    // ④ 예매 기록을 만든다 (status는 스키마 기본값 HELD)
    return this.prisma.reservation.create({
      data: { userId, eventId, quantity },
    });
  }
}
