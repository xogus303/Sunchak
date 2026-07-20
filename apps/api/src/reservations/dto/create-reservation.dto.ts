import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class CreateReservationDto {
  @IsInt()
  @Min(1)
  quantity: number; // 예매 수량 (최소 1)

  // HELD 흐름(strategy=held)에서 재전송을 식별하는 클라이언트 발급 이름표(UUID).
  // W2 5전략에선 보내지 않고 서버가 자동 발급하므로 optional. held에선 서비스가 필수로 강제.
  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}
