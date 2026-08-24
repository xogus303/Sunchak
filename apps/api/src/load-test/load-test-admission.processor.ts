import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { QueueService } from '../queue/queue.service';
import { QueueEventsService } from '../queue/queue-events.service';
import { poissonLikeBatchSize } from '../queue/poisson-batch';
import { LOAD_TEST_ADMISSION_QUEUE } from './load-test-admission.constants';

/**
 * 대용량 트래픽 테스트 전용 입장 처리 워커(ADR 0016 백로그) — 캐주얼
 * AdmissionProcessor(고정 20명/2초)와 완전히 별도. 매 틱 정확히 같은 인원이
 * 아니라, 남은 대기 인원의 일정 비율을 평균(λ)으로 삼아 포아송을 정규분포로
 * 근사한 값을 뽑는다(queue/poisson-batch.ts) — 실제 티켓팅처럼 초반 폭증 →
 * 점점 잦아드는 흐름을 흉내낸다.
 *
 * QueueService.activeLoadTestEventIds()로 캐주얼 이벤트와 완전히 분리된
 * 목록만 보므로, 같은 이벤트를 두 워커가 동시에 ZPOPMIN하는 경합이 없다.
 */
@Processor(LOAD_TEST_ADMISSION_QUEUE)
export class LoadTestAdmissionProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly queueService: QueueService,
    private readonly events: QueueEventsService,
    private readonly config: ConfigService,
    @InjectQueue(LOAD_TEST_ADMISSION_QUEUE)
    private readonly admissionQueue: Queue,
  ) {
    super();
  }

  private intervalMs(): number {
    return Number(
      this.config.get<string>('LOAD_TEST_ADMISSION_INTERVAL_MS') ?? 1_000,
    );
  }
  private meanFraction(): number {
    return Number(
      this.config.get<string>('LOAD_TEST_ADMISSION_MEAN_FRACTION') ?? 0.2,
    );
  }
  private minBatch(): number {
    return Number(this.config.get<string>('LOAD_TEST_ADMISSION_MIN_BATCH') ?? 50);
  }
  private maxBatch(): number {
    return Number(
      this.config.get<string>('LOAD_TEST_ADMISSION_MAX_BATCH') ?? 1_000,
    );
  }

  async onModuleInit() {
    await this.admissionQueue.add(
      'admit',
      {},
      { repeat: { every: this.intervalMs() } },
    );
  }

  async process(_job: Job): Promise<void> {
    const eventIds = await this.queueService.activeLoadTestEventIds();

    for (const eventId of eventIds) {
      const waiting = await this.queueService.size(eventId);
      const batchSize = poissonLikeBatchSize(
        waiting,
        this.meanFraction(),
        this.minBatch(),
        this.maxBatch(),
      );
      if (batchSize > 0) {
        const userIds = await this.queueService.popNext(eventId, batchSize);
        for (const userId of userIds) {
          await this.queueService.admit(eventId, userId);
          this.events.publish({ eventId, userId });
        }
      }
      await this.queueService.deactivateLoadTestIfEmpty(eventId);
    }
  }
}
