import { IsUUID } from 'class-validator';

export class PayDto {
  // 클라이언트 발급 멱등성 키(Reservation과 같은 원칙) — 재전송 식별용.
  // 다만 Payment.reservationId가 이미 @unique(1:1)라 실제 중복 방어는 그걸로도
  // 이뤄진다(ADR 0018 참고). 스키마에 이미 있는 필드를 그대로 채워 넣는다.
  @IsUUID()
  idempotencyKey: string;
}
