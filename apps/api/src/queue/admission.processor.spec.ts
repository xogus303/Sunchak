import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { AdmissionProcessor } from './admission.processor';
import { QueueService } from './queue.service';
import { QueueEventsService } from './queue-events.service';
import { RedisService } from '../redis/redis.service';
import { ADMISSION_QUEUE, ADMISSION_BATCH_SIZE, ACTIVE_QUEUES_KEY } from './queue.constants';

// 핵심(대기열에서 N명 꺼내 허가하고 방송하는 것)이 실제 Redis Sorted Set/TTL을
// 다뤄야 의미 있게 검증된다. process()를 직접 호출해 반복 타이머(2초)를 기다리지 않는다
// (sweep/reconcile과 같은 이유).
describe('AdmissionProcessor (통합 — 입장 처리, ADR 0017)', () => {
  let moduleRef: TestingModule;
  let processor: AdmissionProcessor;
  let queueService: QueueService;
  let events: QueueEventsService;
  let redis: RedisService;

  const eventId = 9002;

  beforeAll(async () => {
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
        BullModule.registerQueue({ name: ADMISSION_QUEUE }),
      ],
      providers: [AdmissionProcessor, QueueService, QueueEventsService, RedisService],
    }).compile();
    await moduleRef.init();

    processor = moduleRef.get(AdmissionProcessor);
    queueService = moduleRef.get(QueueService);
    events = moduleRef.get(QueueEventsService);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    // ⚠️ sweep/reconcile spec과 같은 이유로 obliterate()를 안 쓴다 — 이 세션에서
    // 실제로 겪은 버그: 같은 Redis에 개발 서버가 떠 있으면 그 서버가 onModuleInit에서
    // 등록한 admission 반복 job 스케줄까지 통째로 지워져, 서버를 재시작하기 전까지
    // 대기열 입장 처리가 완전히 멈췄다(대기열엔 계속 쌓이지만 아무도 안 꺼내감).
    await moduleRef.close();
  });

  afterEach(async () => {
    await redis.del(`queue:event:${eventId}`);
    await redis.srem(ACTIVE_QUEUES_KEY, String(eventId));
    const keys = Array.from({ length: 25 }, (_, i) => `admitted:event:${eventId}:${i + 1}`);
    await redis.del(...keys);
  });

  it('대기열 앞에서 배치 크기만큼 꺼내 허가하고, 나머지는 대기열에 남긴다', async () => {
    for (let userId = 1; userId <= ADMISSION_BATCH_SIZE + 5; userId++) {
      await queueService.join(eventId, userId);
    }

    await processor.process({} as Job);

    // 앞 20명은 허가받아 대기열에서 빠지고(rank=null), 뒤 5명은 그대로 대기 중이다.
    await expect(queueService.status(eventId, 1)).resolves.toEqual({ rank: null, admitted: true });
    await expect(queueService.status(eventId, ADMISSION_BATCH_SIZE)).resolves.toEqual({
      rank: null,
      admitted: true,
    });
    await expect(
      queueService.status(eventId, ADMISSION_BATCH_SIZE + 1),
    ).resolves.toEqual({ rank: 0, admitted: false });
  });

  it('허가한 사용자마다 입장 허가 방송을 내보낸다', async () => {
    await queueService.join(eventId, 42);
    const received = firstValueFrom(events.ofUser(eventId, 42));

    await processor.process({} as Job);

    await expect(received).resolves.toEqual({ eventId, userId: 42 });
  });

  it('대기열을 다 비우면 활성 목록(queues:active)에서 제거한다', async () => {
    await queueService.join(eventId, 1);

    await processor.process({} as Job);

    await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(0);
  });

  it('대기열이 배치 크기보다 많이 남아있으면 활성 목록에 그대로 둔다', async () => {
    for (let userId = 1; userId <= ADMISSION_BATCH_SIZE + 1; userId++) {
      await queueService.join(eventId, userId);
    }

    await processor.process({} as Job);

    await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(1);
  });
});
