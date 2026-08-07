import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { QueueModule } from '../queue/queue.module';
import { CONFIRM_QUEUE } from '../reservations/reservations.constants';
import { DemoService } from './demo.service';
import { DemoController } from './demo.controller';

@Module({
  // AuthModule이 export하는 JwtModule을 통해 DemoService가 JwtService를
  // 주입받는다(게이트 토큰 sign/verify — 로그인과 같은 JWT_SECRET 재사용).
  // ReservationsModule이 export하는 ReservationsService로 가상 유저의 예매를
  // 실제 파이프라인(관문→HELD→큐→확정)에 흘려보낸다(축 B-1).
  // QueueModule: 가상 유저도 실사용자와 같은 대기열을 거치게 한다(ADR 0017) —
  // QueueService(join·assertAdmitted)와 QueueEventsService(입장 허가 방송 구독).
  // BullModule.registerQueue: AppModule의 forRootAsync(연결 설정)를 공유하며
  // 'confirm' 큐를 이 모듈에서도 주입 가능하게 한다(축 B-2 — 큐 적체 조회용,
  // job을 넣는 게 아니라 getWaitingCount() 등으로 읽기만 한다).
  imports: [
    AuthModule,
    ReservationsModule,
    QueueModule,
    BullModule.registerQueue({ name: CONFIRM_QUEUE }),
  ],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
