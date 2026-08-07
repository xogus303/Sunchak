import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { QueueService } from './queue.service';
import { QueueEventsService } from './queue-events.service';
import { ADMISSION_BATCH_SIZE, ADMISSION_INTERVAL_MS, ADMISSION_QUEUE } from './queue.constants';

/**
 * 입장 처리 워커(ADR 0017) — sweep·reconcile(0015)과 같은 "시간 자체가 트리거"라
 * BullMQ repeatable job으로 돈다. 외부에서 이 큐에 job을 넣지 않고, 앱이 뜰 때
 * 자기 자신을 반복 등록한다.
 *
 * 대기열이 있는 이벤트마다 앞에서 N명을 꺼내(popNext) 입장 허가(admit)를 내리고,
 * "허가 받았다"를 버스로 방송한다 — 이 방송을 실제로 듣는 건 지금은 DemoService의
 * 가상 유저 자동 예매뿐이지만(실사용자는 폴링 SSE로 순번을 본다), 워커 입장에서는
 * "누가 듣는지" 몰라도 된다(느슨한 결합).
 */
@Processor(ADMISSION_QUEUE)
export class AdmissionProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly queueService: QueueService,
    private readonly events: QueueEventsService,
    @InjectQueue(ADMISSION_QUEUE) private readonly admissionQueue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    await this.admissionQueue.add(
      'admit',
      {},
      { repeat: { every: ADMISSION_INTERVAL_MS } },
    );
  }

  async process(_job: Job): Promise<void> {
    const eventIds = await this.queueService.activeEventIds();

    for (const eventId of eventIds) {
      const userIds = await this.queueService.popNext(eventId, ADMISSION_BATCH_SIZE);
      for (const userId of userIds) {
        await this.queueService.admit(eventId, userId);
        this.events.publish({ eventId, userId });
      }
      await this.queueService.deactivateIfEmpty(eventId);
    }
  }
}
