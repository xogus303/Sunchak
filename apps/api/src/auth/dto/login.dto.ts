import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

/** 로그인 입력 — 회원가입과 달리 최소길이 규칙은 불필요(존재 여부만 확인). */
export class LoginDto {
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다.' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: '비밀번호를 입력하세요.' })
  password: string;
}
