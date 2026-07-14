import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

/**
 * 모듈 = 관련된 컨트롤러·서비스를 하나로 묶는 단위.
 * (로그인·JWT는 다음 단계에서 이 모듈에 추가한다.)
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
