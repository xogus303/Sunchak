import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
 *
 * 백프레셔(2026-09-01, ADR 0023) — 이 계산은 원래 "대기열이 얼마나 남았는가"만
 * 보고 배치 크기를 정했는데, 그러면 뒷단(결제/확정 큐)이 실제로 얼마나 처리
 * 가능한지와 무관하게 사람을 계속 밀어 넣게 된다. 대용량 테스트로 5,000명을
 * 몰아넣어보니 결제 큐가 밀려 job 하나가 처리되기까지 분 단위가 걸렸고, 그
 * 사이 HELD 30초 TTL이 먼저 지나 "결제는 성공인데 예매는 EXPIRED"인 데이터
 * 불일치까지 발생했다(DEVLOG 2026-09-01 참고). Little's Law(L = λ·W)를 적용해
 * "지금 이미 결제 처리 중인(HELD) 인원 수"가 "처리량 × 허가창 시간"을 넘지
 * 않을 만큼만 새로 들여보낸다 — 뒷단이 밀리면 admission이 스스로 느려지고,
 * 대기열(TTL 없음)에서 기다리는 사람만 늘어날 뿐 아무도 조용히 사라지지 않는다.
 *
 * 허가창(W)과 burst 윈도우 분리(2026-09-05) — maxInFlight의 W는 이제
 * admissionWindowMs()(사람이 반응할 시간, 30초)가 아니라 별도의 훨씬 짧은
 * paymentBurstWindowMs()를 쓴다. 자세한 배경은 ADR 0018 철회 이력·아래
 * maxInFlight() 주석 참고 — 요약하면 "허가받은 사람이 반응할 시간"과
 * "결제 단계에 동시에 몰려도 되는 인원 수"는 서로 다른 개념이라 같은
 * 숫자를 쓰면 안 됐다.
 *
 * burst 윈도우 값 자체를 실측으로 재조정(2026-09-08) — 처음엔 이 W를 "결제
 * job의 순수 DB 처리 시간"(약 3초)으로 잘못 잡았다. 실제로는 사람이 결제
 * 버튼을 누르기까지의 랜덤 지연(DEMO_SIM_*_BOOKING_DELAY_MS, 0.5~10초)도
 * "HELD 상태로 시스템에 머무는 시간"에 포함되는데, 이걸 빼먹어 W가 실제보다
 * 훨씬 작았다 — 그 결과 아직 결제 시도조차 안 한 사람들이 좁은 예산을
 * 다 차지해버려, 결제 워커는 놀고 있는데도 입장 자체가 주기적으로(관측:
 * 전체 시간의 약 30%) 완전히 멈추는 현상이 실제 배포 사이트에서 발견됐다.
 * 배포 사이트의 실제 예약 레코드로 "HELD 진입→최종 확정/취소까지" 걸린
 * 시간을 재보니 평균 7.9초·중앙값 9.4초·p90 14.9초 — 이 p90 값을 반올림해
 * 기본값으로 채택(ADR 0023 처리량 실측과 같은 방식·같은 이유: 임의로
 * 추측한 상수 대신 실측값을 쓴다). p90보다 오래 걸리는 나머지도 "안전"한데,
 * `maxInFlight`는 평균 관계식일 뿐 개별 상한 보장이 아니고, `inFlight`
 * 자체를 매 틱 실시간으로 다시 재기 때문에(아래 process() 참고) 실제로
 * 사람들이 예상보다 오래 걸리면 그 틱에 자동으로 덜 들여보내는 식으로
 * 스스로 보정된다.
 */
@Processor(LOAD_TEST_ADMISSION_QUEUE)
export class LoadTestAdmissionProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly queueService: QueueService,
    private readonly events: QueueEventsService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
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

  // 결제→확정 파이프라인이 실제로 초당 처리 가능한 건수(실측값) — 인프라를
  // 바꾸면 이 값도 다시 재야 한다(직전 재측정 이력 아래 참고).
  //
  // 2026-09-01 최초 실측: 70.8/초(concurrency=20, Prisma Client 경유) → 여유
  // 두고 60 채택.
  // 2026-09-09 재측정 — job당 DB 왕복을 줄이는 raw SQL 전환(payment.processor.ts
  // /confirm.processor.ts/createHeld) 이후, admission의 페이스 개입 없이
  // 순수하게 payment 큐만 3,000개 job으로 포화시켜 재측정(Payment.updatedAt
  // 분포, 20.2초에 3,000건 완료) — **지속 초당 150~165건**(끝 구간 제외 평균
  // 약 156). 여유를 두고 130 채택(약 2.2배 개선). 이 값이 낮으면 실제 처리
  // 여력이 있는데도 admission이 옛 기준으로 과소 허가해, 처리 능력 향상의
  // 효과가 체감으로 안 이어지는 문제가 있었다(burst 윈도우는 그대로 15초 —
  // "몇 초 안에 처리되게 할 것인가"는 별개의 설계 선택이라 처리량과 무관하게
  // 유지, 처리량이 오른 만큼 같은 15초 안에 더 많은 인원을 받아들이게 된다).
  private paymentThroughputPerSec(): number {
    return Number(
      this.config.get<string>('LOAD_TEST_PAYMENT_THROUGHPUT_PER_SEC') ?? 130,
    );
  }

  // burst 윈도우 — Little's Law(L=λ·W)의 W. "HELD로 admit된 사람이 최종
  // 확정/취소될 때까지 시스템에 머무는 평균 시간"이어야 한다(2026-09-05
  // 이전엔 admissionWindowMs()를 그대로 재사용해 최대 1,800명까지 동시
  // 허용했던 걸 분리 — ADR 0018 철회 이력 참고).
  //
  // 값 자체는 "결제 job의 순수 DB 처리 시간"(약 3초)이 아니라 "사람이
  // 결제 버튼을 누르기까지의 랜덤 지연(0.5~10초)까지 포함한 전체 체류
  // 시간"이어야 한다 — 처음엔 이걸 빼먹어 W가 실제보다 훨씬 작았고, 아직
  // 결제 시도조차 안 한 사람들이 좁은 예산을 다 차지해 결제 워커는 노는데
  // 입장 자체가 주기적으로 완전히 멈추는 현상이 실제 배포 사이트에서
  // 발견됐다(2026-09-08, ADR 0023 개정 이력 참고). 배포 사이트의 실제
  // HELD→최종 확정/취소 소요 시간을 재보니 평균 7.9초·중앙값 9.4초·
  // p90 14.9초 — ADR 0023의 처리량 실측과 같은 방식으로(임의 추측 대신
  // 실측), p90을 반올림한 15초를 기본값으로 채택. p90을 넘는 나머지도
  // 안전하다 — 이 값은 평균 관계식일 뿐이고, `inFlight`는 매 틱 실시간
  // 재계산되므로(process() 참고) 실제로 더 오래 걸리는 사람이 많아지면
  // 그 틱에 자동으로 덜 들여보내는 식으로 스스로 보정된다.
  private paymentBurstWindowMs(): number {
    return Number(
      this.config.get<string>('LOAD_TEST_PAYMENT_BURST_WINDOW_MS') ?? 15_000,
    );
  }

  // Little's Law(L = λ·W) — burst 윈도우(W) 안에 결제까지 끝나려면, 동시에
  // "이미 허가돼 결제 처리 중인" 인원(L)이 처리량(λ)×burst 윈도우를 넘으면
  // 안 된다.
  private maxInFlight(): number {
    return Math.floor(
      this.paymentThroughputPerSec() * (this.paymentBurstWindowMs() / 1000),
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
      const desiredBatchSize = poissonLikeBatchSize(
        waiting,
        this.meanFraction(),
        this.minBatch(),
        this.maxBatch(),
      );

      // 백프레셔 — 지금 이미 허가돼 결제 처리 중인(HELD) 인원이 뒷단
      // 처리량으로 감당 가능한 상한에 얼마나 여유가 있는지 본다. 여유가
      // 없으면(뒷단이 밀린 상태) 이번 틱엔 아무도 새로 들이지 않고,
      // 대기열(TTL 없음)에서 계속 기다리게 한다. 참고: 허가된 직후 예매
      // 시도까지 약간의 지연(랜덤 딜레이)이 있어 HELD 집계가 한두 틱 정도
      // 늦게 반영될 수 있다 — Little's Law는 평균적 관계라 이 정도 오차는
      // 감안하고 쓰는 근사다(엄밀한 순간값 보장이 아님).
      const inFlight = await this.prisma.reservation.count({
        where: { eventId, status: ReservationStatus.HELD },
      });
      const availableSlots = Math.max(0, this.maxInFlight() - inFlight);
      const batchSize = Math.min(desiredBatchSize, availableSlots);

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
