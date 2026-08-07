import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { QueueService } from './queue.service';
import { RedisService } from '../redis/redis.service';
import { ACTIVE_QUEUES_KEY } from './queue.constants';

// join/admit/assertAdmitted는 '실제' Redis Sorted Set·TTL 동작이 핵심이라
// mock으로는 검증이 무의미하다 — sweep/reconcile과 같은 이유로 통합 테스트로 짠다.
describe('QueueService (통합 — 대기열 admission, ADR 0017)', () => {
  let moduleRef: TestingModule;
  let service: QueueService;
  let redis: RedisService;

  const eventId = 9001; // 이 스펙 전용 가상 이벤트 id(실제 Event 행 불필요 — Redis만 씀)

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [QueueService, RedisService],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(QueueService);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  afterEach(async () => {
    await redis.del(`queue:event:${eventId}`);
    await redis.srem(ACTIVE_QUEUES_KEY, String(eventId));
    await redis.del(`admitted:event:${eventId}:1`, `admitted:event:${eventId}:2`);
  });

  it('join하면 대기열에 순번 0으로 들어가고, 이벤트를 활성 목록에 등록한다', async () => {
    await service.join(eventId, 1);

    const status = await service.status(eventId, 1);
    expect(status).toEqual({ rank: 0, admitted: false });
    await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(1);
  });

  it('두 번째로 join한 사람은 순번 1이다(먼저 온 사람이 앞)', async () => {
    await service.join(eventId, 1);
    await service.join(eventId, 2);

    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: 0, admitted: false });
    await expect(service.status(eventId, 2)).resolves.toEqual({ rank: 1, admitted: false });
  });

  it('같은 사람이 다시 join해도(중복 클릭) 원래 순번을 유지한다', async () => {
    await service.join(eventId, 1);
    await service.join(eventId, 2);
    await service.join(eventId, 1); // 중복 클릭

    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: 0, admitted: false });
  });

  it('입장 허가(admit) 전에는 assertAdmitted가 거부한다', async () => {
    await service.join(eventId, 1);

    await expect(service.assertAdmitted(eventId, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('popNext로 꺼낸 뒤 admit하면 assertAdmitted를 통과하고, status는 rank null/admitted true다', async () => {
    await service.join(eventId, 1);
    await service.join(eventId, 2);

    const popped = await service.popNext(eventId, 1);
    expect(popped).toEqual([1]); // 먼저 온 사람만 1명 꺼냄
    await service.admit(eventId, 1);

    await expect(service.assertAdmitted(eventId, 1)).resolves.toBeUndefined();
    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: null, admitted: true });
    // 아직 대기열에 남은 2번은 popNext로 꺼내지 않았으니 순번이 0으로 당겨진다.
    await expect(service.status(eventId, 2)).resolves.toEqual({ rank: 0, admitted: false });
  });

  it('deactivateIfEmpty는 대기열이 비었을 때만 활성 목록에서 제거한다', async () => {
    await service.join(eventId, 1);
    await service.popNext(eventId, 10); // 전원 꺼내 대기열을 비움

    await service.deactivateIfEmpty(eventId);

    await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(0);
  });

  it('activeEventIds는 대기열이 있는 이벤트 id만 숫자로 돌려준다', async () => {
    await service.join(eventId, 1);

    const ids = await service.activeEventIds();

    expect(ids).toContain(eventId);
  });

  it('size는 아직 허가를 못 받고 대기 중인 인원 수를 돌려준다', async () => {
    await service.join(eventId, 1);
    await service.join(eventId, 2);
    await service.popNext(eventId, 1); // 1명은 허가 처리(대기열에서 빠짐)

    await expect(service.size(eventId)).resolves.toBe(1);
  });

  it('입장 허가창(TTL)이 지나면 Redis가 자연 만료시켜 assertAdmitted가 다시 거부한다', async () => {
    process.env.QUEUE_ADMISSION_WINDOW_MS = '50'; // 이 테스트만 아주 짧게
    await service.join(eventId, 1);
    await service.admit(eventId, 1);
    await expect(service.assertAdmitted(eventId, 1)).resolves.toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 100)); // TTL(50ms)보다 넉넉히

    await expect(service.assertAdmitted(eventId, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    delete process.env.QUEUE_ADMISSION_WINDOW_MS; // 다음 테스트에 안 새게
  });

  it('purge는 대기 중인 사람을 비우고 활성 목록에서도 제거한다(데모 리셋용)', async () => {
    await service.join(eventId, 1);
    await service.join(eventId, 2);

    await service.purge(eventId);

    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: null, admitted: false });
    await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(0);
  });
});
