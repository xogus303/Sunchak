import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EventsModule } from '../events/events.module';
import { QueueModule } from '../queue/queue.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { LoadTestService } from './load-test.service';
import { LoadTestController } from './load-test.controller';
import { LoadTestAdmissionProcessor } from './load-test-admission.processor';
import { LOAD_TEST_ADMISSION_QUEUE } from './load-test-admission.constants';
import { CONFIRM_QUEUE } from '../reservations/reservations.constants';

@Module({
  // EventsModule: findOrCreateOwnLoadTestEvent()로 "이 유저의 대용량 테스트
  // 이벤트"를 얻는다. QueueModule: 대기열 진입(joinLoadTest)·리셋(purge)·
  // 입장 허가 방송(QueueEventsService). ReservationsModule: 가상 유저의
  // 예매·결제를 실제 파이프라인(관문→HELD→큐→확정)에 흘려보낸다(캐주얼
  // 데모의 DemoModule과 같은 이유). sweep/reconcile(0015)과 같은 이유로
  // 대용량 전용 입장 처리도 재시도 백오프가 불필요하다 — 시간 자체가
  // 트리거라 이번 틱이 실패해도 다음 틱이 만회한다.
  // 'confirm' 큐 registerQueue: demo.module.ts와 같은 이유(streamStats의 큐
  // 적체 조회, getWaitingCount/getActiveCount만 읽고 job은 안 넣는다).
  imports: [
    EventsModule,
    QueueModule,
    ReservationsModule,
    BullModule.registerQueue({
      name: LOAD_TEST_ADMISSION_QUEUE,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
    }),
    BullModule.registerQueue({ name: CONFIRM_QUEUE }),
  ],
  controllers: [LoadTestController],
  providers: [LoadTestService, LoadTestAdmissionProcessor],
})
export class LoadTestModule {}
