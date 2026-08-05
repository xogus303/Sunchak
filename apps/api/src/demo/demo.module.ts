import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { DemoService } from './demo.service';
import { DemoController } from './demo.controller';

@Module({
  // AuthModule이 export하는 JwtModule을 통해 DemoService가 JwtService를
  // 주입받는다(게이트 토큰 sign/verify — 로그인과 같은 JWT_SECRET 재사용).
  // ReservationsModule이 export하는 ReservationsService로 가상 유저의 예매를
  // 실제 파이프라인(관문→HELD→큐→확정)에 흘려보낸다(축 B-1).
  imports: [AuthModule, ReservationsModule],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
