import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * DTO(Data Transfer Object) — 클라이언트가 보내는 요청 본문의 "모양과 규칙"을 정의한다.
 * 데코레이터(@IsEmail 등)가 검증 규칙이며, ValidationPipe가 이 규칙으로 입력을 걸러낸다.
 */
export class SignupDto {
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다.' })
  email: string;

  @IsString()
  @MinLength(8, { message: '비밀번호는 최소 8자 이상이어야 합니다.' })
  @MaxLength(128, { message: '비밀번호가 너무 깁니다.' })
  password: string;
}
