import { IsInt, Min } from 'class-validator';

export class CreateReservationDto {
  @IsInt()
  @Min(1)
  quantity: number; // 예매 수량 (최소 1)
}
