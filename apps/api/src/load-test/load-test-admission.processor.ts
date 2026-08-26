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

  // 캐주얼(QUEUE_ADMISSION_WINDOW_MS, 기본 8초)과 공유하던 걸 분리(2026-08-26) —
  // 8초는 원래 캐주얼 가상 유저의 반응 속도에 맞춘 값이라, 대용량 화면에서
  // 순번·ETA·전체 현황을 읽고 "예매하기"를 누르기엔 실제 사람에게 촉박했다.
  private admissionWindowMs(): number {
    return Number(
      this.config.get<string>('LOAD_TEST_ADMISSION_WINDOW_MS') ?? 30_000,
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
        // admission.processor.ts(캐주얼)와 같은 이유로 Promise.all — 대용량은
        // 배치가 최대 1000명까지 가능해, 한 명씩 순차로 기다리면 "대기열에서는
        // 빠졌지만 아직 admit()이 안 끝난" 틈이 1초 넘게 벌어질 수 있다. 그 틈에
        // 폴링이 걸리면 프론트가 "허가창 만료"로 오판한다(2026-08-26 실사용 중
        // 발견 — 대용량 쪽이 배치가 커서 특히 잘 걸렸다).
        await Promise.all(
          userIds.map(async (userId) => {
            await this.queueService.admit(eventId, userId, this.admissionWindowMs());
            this.events.publish({ eventId, userId });
          }),
        );
      }
      await this.queueService.deactivateLoadTestIfEmpty(eventId);
    }
  }
}
