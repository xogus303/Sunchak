import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
import { ReservationStreamController } from './reservation-stream.controller';
import { ReservationEventsService } from './reservation-events.service';
import { ConfirmProcessor } from './confirm.processor';
import { CONFIRM_QUEUE } from './reservations.constants';

@Module({
  imports: [
    // 'confirm' 큐를 이 모듈에 등록 → @InjectQueue로 주입 가능.
    // defaultJobOptions: 이 큐에 넣는 모든 job의 기본 재시도·정리 정책.
    //   - attempts 3 + 지수 백오프: 확정 실패(DB 일시 장애) 시 1s→2s→4s 간격 재시도.
    //   - removeOnComplete: 성공 job은 Redis에서 즉시 제거(누적 방지).
    //   - removeOnFail: false → 3회 다 실패한 job은 남겨 원인 추적(운영 관찰용).
    BullModule.registerQueue({
      name: CONFIRM_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [ReservationsController, ReservationStreamController],
  providers: [ReservationsService, ReservationEventsService, ConfirmProcessor],
})
export class ReservationsModule {}
