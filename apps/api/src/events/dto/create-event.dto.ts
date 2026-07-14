import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateEventDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsInt()
  @Min(0)
  price: number; // 원(KRW) 정수

  @IsISO8601()
  openAt: string; // ISO-8601 문자열 (예: "2026-08-01T20:00:00Z")

  @IsInt()
  @Min(1)
  totalQty: number; // 총 좌석 수
}
