import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { ReservationStatus } from '@prisma/client';
import { LoadTestAdmissionProcessor } from './load-test-admission.processor';
import { LOAD_TEST_ADMISSION_QUEUE } from './load-test-admission.constants';
import { QueueService } from '../queue/queue.service';
import { QueueEventsService } from '../queue/queue-events.service';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_QUEUES_KEY, LOAD_TEST_ACTIVE_QUEUES_KEY } from '../queue/queue.constants';

// 캐주얼 admission.processor.spec.ts와 같은 이유(실제 Redis Sorted Set/TTL이 있어야
// 의미 있게 검증됨) + process()를 직접 호출해 반복 타이머를 기다리지 않는다.
//
// 배치 크기가 변동(poissonLikeBatchSize)이라 "정확히 몇 명"은 단언할 수 없다 —
// 대신 clamp가 보장하는 범위([MIN,MAX])로 검증한다. 남은 인원이 MIN보다 훨씬
// 적을 때는 poissonLikeBatchSize 자체가 "남은 인원 전부"를 결정적으로 돌려주므로
// (poisson-batch.spec.ts에서 이미 검증) 그 경우엔 정확한 값도 단언할 수 있다.
describe('LoadTestAdmissionProcessor (통합 — 대용량 입장 처리, ADR 0016 백로그)', () => {
  let moduleRef: TestingModule;
  let processor: LoadTestAdmissionProcessor;
  let queueService: QueueService;
  let events: QueueEventsService;
  let redis: RedisService;
  let admissionQueue: Queue;

  const eventId = 9101;
  const MIN_BATCH = 50;
  const MAX_BATCH = 100;
  // 백프레셔 테스트용 — 처리량 10건/초 × 허가창 5초(아래 WINDOW_MS) = 50명.
  const MAX_IN_FLIGHT = 50;

  beforeAll(async () => {
    process.env.LOAD_TEST_ADMISSION_MEAN_FRACTION = '0.2';
    process.env.LOAD_TEST_ADMISSION_MIN_BATCH = String(MIN_BATCH);
    process.env.LOAD_TEST_ADMISSION_MAX_BATCH = String(MAX_BATCH);
    process.env.LOAD_TEST_PAYMENT_THROUGHPUT_PER_SEC = '10';
    // onModuleInit이 등록하는 반복(repeat) job이 테스트 도중 배경에서 저절로
    // 실행되면 process()를 수동으로 부른 결과와 겹쳐(=경합) 허가 인원이 예상
    // 범위를 벗어난다(실측: 500명 투입 테스트가 251명 허가로 실패 — 수동 호출
    // 1번 + 배경 자동 틱 최소 1번이 겹친 결과). 주기를 이 파일의 전체 실행
    // 시간보다 훨씬 길게 잡아 배경 틱이 절대 안 끼어들게 한다.
    process.env.LOAD_TEST_ADMISSION_INTERVAL_MS = '600000';
    // 캐주얼 기본값(QUEUE_ADMISSION_WINDOW_MS=8000)과 뚜렷이 구분되는 값으로
    // 둬서, admit()이 실제로 이 값을 쓰는지(캐주얼 기본값이 새지 않았는지)
    // 아래 테스트에서 확인한다(2026-08-26).
    process.env.LOAD_TEST_ADMISSION_WINDOW_MS = '5000';

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            const url = new URL(
              config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
            );
            return { connection: { host: url.hostname, port: Number(url.port) || 6379 } };
          },
        }),
        BullModule.registerQueue({ name: LOAD_TEST_ADMISSION_QUEUE }),
      ],
      providers: [
        LoadTestAdmissionProcessor,
        QueueService,
        QueueEventsService,
        RedisService,
        PrismaService,
      ],
    }).compile();
    await moduleRef.init();

    processor = moduleRef.get(LoadTestAdmissionProcessor);
    queueService = moduleRef.get(QueueService);
    events = moduleRef.get(QueueEventsService);
    redis = moduleRef.get(RedisService);
    admissionQueue = moduleRef.get(getQueueToken(LOAD_TEST_ADMISSION_QUEUE));
  });

  afterAll(async () => {
    // onModuleInit이 등록한 반복 스케줄러를 지우지 않으면, 다음 테스트 실행
    // 때도 이번에 등록한 스케줄이 Redis에 계속 남아 배경에서 계속 발동한다
    // (실제로 이 문제로 500명 테스트가 처음엔 계속 실패했었다 — 예전 실행이
    // 남긴 1초 주기 스케줄이 그대로 살아있었던 것). obliterate()는 같은
    // Redis에 떠 있는 다른 프로세스의 스케줄까지 지울 위험이 있어(기존
    // admission.processor.spec.ts 교훈) 안 쓰고, 이 테스트가 등록한 스케줄
    // 하나만 정확히 지운다.
    //
    // ⚠️ removeJobScheduler()는 job "이름"('admit')이 아니라 getJobSchedulers()가
    // 돌려주는 해시형 key를 받는다 — 이름을 넘기면 조용히 false를 반환하고
    // 아무것도 안 지워진다(실측으로 발견, BullMQ 문서에 명확히 안 나와 있음).
    const schedulers = await admissionQueue.getJobSchedulers();
    await Promise.all(schedulers.map((s) => admissionQueue.removeJobScheduler(s.key)));
    delete process.env.LOAD_TEST_ADMISSION_MEAN_FRACTION;
    delete process.env.LOAD_TEST_ADMISSION_MIN_BATCH;
    delete process.env.LOAD_TEST_ADMISSION_MAX_BATCH;
    delete process.env.LOAD_TEST_ADMISSION_INTERVAL_MS;
    delete process.env.LOAD_TEST_ADMISSION_WINDOW_MS;
    delete process.env.LOAD_TEST_PAYMENT_THROUGHPUT_PER_SEC;
    // ⚠️ admission.processor.spec.ts와 같은 이유로 obliterate()를 안 쓴다.
    await moduleRef.close();
  });

  afterEach(async () => {
    await redis.del(`queue:event:${eventId}`);
    await redis.srem(LOAD_TEST_ACTIVE_QUEUES_KEY, String(eventId));
    const keys = Array.from({ length: 500 }, (_, i) => `admitted:event:${eventId}:${i + 1}`);
    await redis.del(...keys);
  });

  it('한 틱에 [MIN,MAX] 범위 안의 인원만 꺼내 허가하고, 나머지는 대기열에 남긴다', async () => {
    const totalJoined = 500;
    for (let userId = 1; userId <= totalJoined; userId++) {
      await queueService.joinLoadTest(eventId, userId);
    }

    await processor.process({} as Job);

    const remaining = await queueService.size(eventId);
    const admittedCount = totalJoined - remaining;
    // λ=clamp(500×0.2=100,50,100)=100(상한에 걸림) → 실제 뽑힌 값은 항상
    // [MIN,MAX]=[50,100] 안이라는 게 poissonLikeBatchSize의 clamp로 보장된다.
    expect(admittedCount).toBeGreaterThanOrEqual(MIN_BATCH);
    expect(admittedCount).toBeLessThanOrEqual(MAX_BATCH);
    expect(remaining).toBe(totalJoined - admittedCount);
  });

  it('남은 인원이 MIN보다 적으면 남은 인원 전부를 정확히 허가한다', async () => {
    await queueService.joinLoadTest(eventId, 1);
    await queueService.joinLoadTest(eventId, 2);
    await queueService.joinLoadTest(eventId, 3);

    await processor.process({} as Job);

    await expect(queueService.size(eventId)).resolves.toBe(0);
    await expect(queueService.status(eventId, 1)).resolves.toEqual({
      rank: null,
      admitted: true,
      etaSeconds: null,
    });
    await expect(queueService.status(eventId, 3)).resolves.toEqual({
      rank: null,
      admitted: true,
      etaSeconds: null,
    });
  });

  it('허가한 사용자마다 입장 허가 방송을 내보낸다', async () => {
    await queueService.joinLoadTest(eventId, 42);
    const received = firstValueFrom(events.ofUser(eventId, 42));

    await processor.process({} as Job);

    await expect(received).resolves.toEqual({ eventId, userId: 42 });
  });

  it('대기열을 다 비우면 대용량 전용 활성 목록에서 제거한다', async () => {
    await queueService.joinLoadTest(eventId, 1);

    await processor.process({} as Job);

    await expect(
      redis.sismember(LOAD_TEST_ACTIVE_QUEUES_KEY, String(eventId)),
    ).resolves.toBe(0);
  });

  it('대기열이 많이 남아있으면 활성 목록에 그대로 둔다', async () => {
    for (let userId = 1; userId <= 500; userId++) {
      await queueService.joinLoadTest(eventId, userId);
    }

    await processor.process({} as Job);

    await expect(
      redis.sismember(LOAD_TEST_ACTIVE_QUEUES_KEY, String(eventId)),
    ).resolves.toBe(1);
  });

  // 2026-08-26 — "예매 가능 시간이 너무 짧다"는 실사용 피드백으로 캐주얼과
  // 분리한 대용량 전용 허가창(LOAD_TEST_ADMISSION_WINDOW_MS).
  it('허가창은 캐주얼 기본값(8초)이 아니라 LOAD_TEST_ADMISSION_WINDOW_MS(여기선 5초)를 쓴다', async () => {
    await queueService.joinLoadTest(eventId, 1);

    await processor.process({} as Job);

    const pttl = await redis.pttl(`admitted:event:${eventId}:1`);
    // 정확히 5000은 타이밍상 어려우니, 캐주얼 기본값(8000)과는 확실히 구분되는
    // 대용량 설정값(5000) 근처인지만 확인한다.
    expect(pttl).toBeGreaterThan(4000);
    expect(pttl).toBeLessThanOrEqual(5000);
  });

  it('캐주얼 데모 활성 목록(ACTIVE_QUEUES_KEY)은 건드리지 않는다 — 완전히 별도 경로', async () => {
    await queueService.joinLoadTest(eventId, 1);

    await processor.process({} as Job);

    // 애초에 joinLoadTest는 LOAD_TEST_ACTIVE_QUEUES_KEY에만 등록하므로, 캐주얼
    // 쪽 목록엔 이 이벤트가 존재한 적조차 없어야 한다.
    await expect(
      redis.sismember(ACTIVE_QUEUES_KEY, String(eventId)),
    ).resolves.toBe(0);
  });

  // 2026-09-01, ADR 0023 — 대기열 크기만 보던 배치 계산에 "지금 이미 결제
  // 처리 중인(HELD) 인원이 처리량 상한에 얼마나 여유가 있는지"를 더한다.
  // Reservation은 실제 FK(Event/User)가 있어야 해서, 이 describe만 별도로
  // 진짜 Event/User를 만들어 쓴다(위 eventId=9101은 Redis 전용 가짜 id라 못 씀).
  describe('백프레셔(처리량 상한을 넘으면 새로 허가하지 않는다)', () => {
    let prisma: PrismaService;
    let bpEventId: number;
    let seedUserId: number;

    beforeAll(async () => {
      prisma = moduleRef.get(PrismaService);
      const user = await prisma.user.create({
        data: { email: `admission-backpressure-${randomUUID()}@test.local`, password: 'x' },
      });
      seedUserId = user.id;
      const event = await prisma.event.create({
        data: { title: '백프레셔 테스트', price: 1000, openAt: new Date() },
      });
      bpEventId = event.id;
    });

    afterEach(async () => {
      await prisma.reservation.deleteMany({ where: { eventId: bpEventId } });
      await redis.del(`queue:event:${bpEventId}`);
      await redis.srem(LOAD_TEST_ACTIVE_QUEUES_KEY, String(bpEventId));
      const keys = Array.from({ length: 500 }, (_, i) => `admitted:event:${bpEventId}:${i + 1}`);
      await redis.del(...keys);
    });

    afterAll(async () => {
      await prisma.event.delete({ where: { id: bpEventId } });
      await prisma.user.delete({ where: { id: seedUserId } });
    });

    async function seedHeld(count: number) {
      for (let i = 0; i < count; i++) {
        await prisma.reservation.create({
          data: {
            userId: seedUserId,
            eventId: bpEventId,
            quantity: 1,
            idempotencyKey: randomUUID(),
            status: ReservationStatus.HELD,
          },
        });
      }
    }

    it('이미 HELD가 처리량 상한(10건/초 × 5초 = 50명)만큼 있으면, 대기열이 많아도 아무도 새로 허가하지 않는다', async () => {
      await seedHeld(MAX_IN_FLIGHT);
      for (let userId = 1; userId <= 500; userId++) {
        await queueService.joinLoadTest(bpEventId, userId);
      }

      await processor.process({} as Job);

      await expect(queueService.size(bpEventId)).resolves.toBe(500);
    });

    it('여유분만큼만 허가하고 나머지는 대기열(TTL 없음)에 그대로 남긴다', async () => {
      const alreadyHeld = MAX_IN_FLIGHT - 20; // 여유 20명
      await seedHeld(alreadyHeld);
      for (let userId = 1; userId <= 500; userId++) {
        await queueService.joinLoadTest(bpEventId, userId);
      }

      await processor.process({} as Job);

      const remaining = await queueService.size(bpEventId);
      expect(500 - remaining).toBe(20);
    });
  });
});
