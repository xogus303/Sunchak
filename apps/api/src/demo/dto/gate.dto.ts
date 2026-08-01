import { IsNotEmpty, IsString } from 'class-validator';

export class GateDto {
  @IsString()
  @IsNotEmpty({ message: '비밀번호를 입력하세요.' })
  password: string;
}
