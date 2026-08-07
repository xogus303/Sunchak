import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueService } from './queue.service';
import { QueueEventsService } from './queue-events.service';
import { QueueController } from './queue.controller';
import { AdmissionProcessor } from './admission.processor';
import { ADMISSION_QUEUE } from './queue.constants';

@Module({
  imports: [
    // sweep·reconcile(0015)과 같은 이유로 재시도 백오프가 불필요하다 — "시간
    // 자체"가 트리거라 이번 틱이 실패해도 다음 틱이 전체를 다시 훑어 만회한다.
    BullModule.registerQueue({
      name: ADMISSION_QUEUE,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
    }),
  ],
  controllers: [QueueController],
  providers: [QueueService, QueueEventsService, AdmissionProcessor],
  // ReservationsModule(컨트롤러의 assertAdmitted 체크)과 DemoModule(가상 유저의
  // 대기열 진입 + 입장 허가 방송 구독)이 이 모듈을 가져다 쓴다.
  exports: [QueueService, QueueEventsService],
})
export class QueueModule {}
