import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DemoService } from './demo.service';
import { DemoController } from './demo.controller';

@Module({
  // AuthModule이 export하는 JwtModule을 통해 DemoService가 JwtService를
  // 주입받는다(게이트 토큰 sign/verify — 로그인과 같은 JWT_SECRET 재사용).
  imports: [AuthModule],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
