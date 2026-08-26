import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { QueueService } from './queue.service';
import { QueueEventsService } from './queue-events.service';
import { RedisService } from '../redis/redis.service';
import { ACTIVE_QUEUES_KEY, ADMISSION_BATCH_SIZE, ADMISSION_INTERVAL_MS } from './queue.constants';

// status()의 eta 계산과 같은 식 — 상수를 그대로 참조해 배치 크기/주기가 바뀌어도
// 테스트가 따라간다(숫자를 하드코딩하면 상수 변경 시 조용히 안 맞게 된다).
function expectedEta(rank: number): number {
  return Math.ceil((rank + 1) / ADMISSION_BATCH_SIZE) * (ADMISSION_INTERVAL_MS / 1000);
}

// join/admit/assertAdmitted는 '실제' Redis Sorted Set·TTL 동작이 핵심이라
// mock으로는 검증이 무의미하다 — sweep/reconcile과 같은 이유로 통합 테스트로 짠다.
describe('QueueService (통합 — 대기열 admission, ADR 0017)', () => {
  let moduleRef: TestingModule;
  let service: QueueService;
  let redis: RedisService;
  let events: QueueEventsService;

  const eventId = 9001; // 이 스펙 전용 가상 이벤트 id(실제 Event 행 불필요 — Redis만 씀)

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [QueueService, RedisService, QueueEventsService],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(QueueService);
    redis = moduleRef.get(RedisService);
    events = moduleRef.get(QueueEventsService);
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
    expect(status).toEqual({ rank: 0, admitted: false, etaSeconds: expectedEta(0) });
    await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(1);
  });

  // 2026-08-26 실사용 중 발견 — 대용량(포아송 변동 배치)인데 캐주얼 고정 배치
  // 공식으로 ETA를 계산해 "예상 대기가 분 단위였다가 52초였다가 한다"는 버그.
  // admissionModel을 넘기면 그 모델로 계산해야 한다.
  describe('ETA — admissionModel을 넘기면(대용량) 캐주얼 고정 공식 대신 그 모델로 계산한다', () => {
    it('대기열이 minBatch보다 작으면 minBatch로 clamp해서 계산한다', async () => {
      await service.join(eventId, 1);
      const model = { meanFraction: 0.2, minBatch: 50, maxBatch: 1000, intervalMs: 1000 };

      // waiting=1 → expectedBatch = clamp(1*0.2, 50, 1000) = 50 → batchesAhead = ceil(1/50) = 1 → eta = 1초.
      // 캐주얼 고정 공식(expectedEta(0))이었다면 다른 값이 나왔을 것 — 모델이 실제로 쓰였는지 확인.
      await expect(service.status(eventId, 1, model)).resolves.toEqual({
        rank: 0,
        admitted: false,
        etaSeconds: 1,
      });
    });

    it('대기열이 충분히 크면(minBatch 이상) meanFraction 비율로 계산한다', async () => {
      for (let i = 1; i <= 8; i++) {
        await service.join(eventId, i);
      }
      const model = { meanFraction: 0.25, minBatch: 1, maxBatch: 1000, intervalMs: 500 };

      // waiting=8 → expectedBatch = clamp(8*0.25=2, 1, 1000) = 2. 8번째 사람(rank 7)은
      // batchesAhead = ceil(8/2) = 4 → eta = 4 * 0.5초 = 2초.
      await expect(service.status(eventId, 8, model)).resolves.toEqual({
        rank: 7,
        admitted: false,
        etaSeconds: 2,
      });
    });

    it('admissionModel을 안 넘기면(캐주얼) 기존 고정 공식 그대로다', async () => {
      await service.join(eventId, 1);

      await expect(service.status(eventId, 1)).resolves.toEqual({
        rank: 0,
        admitted: false,
        etaSeconds: expectedEta(0),
      });
    });
  });

  it('두 번째로 join한 사람은 순번 1이다(먼저 온 사람이 앞)', async () => {
    await service.join(eventId, 1);
    await service.join(eventId, 2);

    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: 0, admitted: false, etaSeconds: expectedEta(0) });
    await expect(service.status(eventId, 2)).resolves.toEqual({ rank: 1, admitted: false, etaSeconds: expectedEta(1) });
  });

  it('같은 사람이 다시 join해도(중복 클릭) 원래 순번을 유지한다', async () => {
    await service.join(eventId, 1);
    await service.join(eventId, 2);
    await service.join(eventId, 1); // 중복 클릭

    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: 0, admitted: false, etaSeconds: expectedEta(0) });
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
    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: null, admitted: true, etaSeconds: null });
    // 아직 대기열에 남은 2번은 popNext로 꺼내지 않았으니 순번이 0으로 당겨진다.
    await expect(service.status(eventId, 2)).resolves.toEqual({ rank: 0, admitted: false, etaSeconds: expectedEta(0) });
  });

  // 방문자가 이벤트 상세를 나갔다 재진입하면 프론트가 join을 다시 호출하는데,
  // 이전 admitted 키(TTL 8초)가 아직 안 끝났으면 그대로 남아 "대기 없이 곧장
  // 허가됨" 화면으로 튀어버리는 버그가 있었다(2026-08-07 실사용 중 발견).
  it('허가 후 재입장(join)하면 이전 허가는 무효화되고 새 순번으로 다시 대기한다', async () => {
    await service.join(eventId, 1);
    await service.popNext(eventId, 1); // 실제 허가 흐름(AdmissionProcessor)처럼 큐에서 뺀 뒤 허가
    await service.admit(eventId, 1);
    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: null, admitted: true, etaSeconds: null });

    await service.join(eventId, 2); // 다른 사람이 먼저 대기열에 서 있는 상태
    await service.join(eventId, 1); // 1번이 재입장(예: 페이지 재진입)

    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: 1, admitted: false, etaSeconds: expectedEta(1) });
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

  // 2026-08-26 — 대용량은 캐주얼과 다른(더 긴) 허가창을 쓴다(LoadTestAdmissionProcessor가
  // 이 파라미터로 넘김). env(QUEUE_ADMISSION_WINDOW_MS, 기본 8초)를 안 건드려도
  // 파라미터가 우선해야 한다.
  it('admit에 windowMs를 직접 넘기면 QUEUE_ADMISSION_WINDOW_MS 대신 그 값을 쓴다', async () => {
    await service.join(eventId, 1);
    await service.admit(eventId, 1, 50); // env 기본값(8초)보다 훨씬 짧게 직접 지정
    await expect(service.assertAdmitted(eventId, 1)).resolves.toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 100)); // 지정한 50ms보다 넉넉히

    await expect(service.assertAdmitted(eventId, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('purge는 대기 중인 사람을 비우고 활성 목록에서도 제거한다(데모 리셋용)', async () => {
    await service.join(eventId, 1);
    await service.join(eventId, 2);

    await service.purge(eventId);

    await expect(service.status(eventId, 1)).resolves.toEqual({ rank: null, admitted: false, etaSeconds: null });
    await expect(redis.sismember(ACTIVE_QUEUES_KEY, String(eventId))).resolves.toBe(0);
  });

  // ADR 0017 백로그(2026-08-15) — "허가되는 순간을 이벤트 기반으로 전환". 폴링
  // 주기(1초)를 기다리지 않고, AdmissionProcessor가 방송하는 즉시 status를
  // 다시 흘려보내는지 확인한다(폴링 자체는 그대로 유지되므로 admitted 스냅샷이
  // 최소 2번 — 초기 폴링 1회 + 이벤트 트리거 1회 — 이상 나온다).
  it('streamStatus는 입장 허가 이벤트가 오면 폴링 주기를 기다리지 않고 즉시 admitted 상태를 흘려보낸다', async () => {
    await service.join(eventId, 1);

    const snapshots$ = service.streamStatus(eventId, 1).pipe(take(2), toArray());
    const snapshotsPromise = firstValueFrom(snapshots$);

    await service.popNext(eventId, 1);
    await service.admit(eventId, 1);
    events.publish({ eventId, userId: 1 }); // AdmissionProcessor가 하는 것과 동일

    const snapshots = await snapshotsPromise;
    const admittedSnapshot = snapshots.find((s) => (s.data as { admitted: boolean }).admitted);
    expect(admittedSnapshot).toBeDefined();
    expect(admittedSnapshot!.data).toEqual({ rank: null, admitted: true, etaSeconds: null });
  });

  it('eta는 대기 순번이 몇 번째 입장 처리 배치에서 빠지는지를 반영한다', async () => {
    // ADMISSION_BATCH_SIZE(20)명씩 들어가므로, 정확히 한 배치 크기만큼 앞서
    // 대기 중인 사람은 다음 배치가 아니라 그다음 배치에서 빠진다.
    await Promise.all(
      Array.from({ length: ADMISSION_BATCH_SIZE + 1 }, (_, i) => service.join(eventId, i + 1)),
    );

    const last = await service.status(eventId, ADMISSION_BATCH_SIZE + 1);
    expect(last.rank).toBe(ADMISSION_BATCH_SIZE); // 0-indexed, 배치 크기와 같은 순번 = 21번째
    expect(last.etaSeconds).toBe(expectedEta(ADMISSION_BATCH_SIZE));
  });
});
