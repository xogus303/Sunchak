import { ForbiddenException, Injectable, MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { merge, Observable, timer } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { RedisService } from '../redis/redis.service';
import { QueueEventsService } from './queue-events.service';
import {
  ACTIVE_QUEUES_KEY,
  ADMISSION_BATCH_SIZE,
  ADMISSION_INTERVAL_MS,
  LOAD_TEST_ACTIVE_QUEUES_KEY,
} from './queue.constants';

// SSE 순번 확인 폴링 주기 — 0016 stats 대시보드와 같은 값(체감상 실시간, 구현은 단순).
const STATUS_POLL_INTERVAL_MS = 1_000;

// 한 스냅샷의 모양 — 대기 중이면 순번(0부터), 입장 허가를 받았으면 rank는 null이 되고
// admitted가 true로 바뀐다. 둘 다 null/false면 대기열에 없다(=한 번도 안 들어왔거나
// 허가창이 만료돼 밀려난 것). etaSeconds는 대기 중일 때만 값이 있다.
export interface QueueStatus {
  rank: number | null;
  admitted: boolean;
  etaSeconds: number | null;
}

/**
 * 선착순 입장 대기열(ADR 0017) — "언제 관문(0014)에 도전할 자격을 주는가"만
 * 관장한다. 관문·HELD·확정 파이프라인(0014/0015)은 이 서비스가 전혀 모른다.
 *
 * 자료구조:
 * - `queue:event:{id}` (Sorted Set) — member=userId, score=진입시각. FIFO.
 * - `admitted:event:{id}:{userId}` — TTL(입장 허가창)이 지나면 Redis가 알아서
 *   지워준다. 허가는 아직 재고를 안 건드린 상태라 유실돼도 정합성 문제가 없어
 *   HELD(0015)처럼 DB에 흔적을 남기고 회수(sweep)할 필요가 없다.
 * - `queues:active` (Set) — 대기열이 비어있지 않은 이벤트 id 모음(AdmissionProcessor가
 *   전체 이벤트를 훑지 않고 이 목록만 보게 함).
 */
@Injectable()
export class QueueService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly events: QueueEventsService,
  ) {}

  private admissionWindowMs(): number {
    return Number(this.config.get<string>('QUEUE_ADMISSION_WINDOW_MS') ?? 8000);
  }

  private queueKey(eventId: number): string {
    return `queue:event:${eventId}`;
  }

  private admittedKey(eventId: number, userId: number): string {
    return `admitted:event:${eventId}:${userId}`;
  }

  // ZSet score로 쓸 "진입 순서" 채번 — Redis INCR은 싱글 스레드라 동시에 여러
  // join()이 들어와도 절대 같은 값을 두 번 못 받는다(원자적 단조 증가).
  private queueSeqKey(eventId: number): string {
    return `queue:seq:event:${eventId}`;
  }

  // NX(멤버가 없을 때만 추가) — 중복 클릭이 원래 진입 순서를 다시 지금으로
  // 밀어버리지 않게 한다.
  //
  // ⚠️ score를 Date.now()(밀리초 타임스탬프)로 쓰다가 CI에서 실패로 발견(2026-08-21):
  // 두 join()이 같은 밀리초 안에 끝나면 score가 동점이 되고, ZSet은 동점을
  // 멤버 문자열 사전순으로 정렬해버려 "1"이 "2"보다 먼저 왔어도 순번이 뒤집힌다.
  // 로컬은 Redis 왕복 지연으로 우연히 안 겹쳤을 뿐, 실제 선착순 트래픽이 몰리는
  // 상황(이 큐가 존재하는 이유 그 자체)에서도 똑같이 터질 수 있는 진짜 공정성
  // 버그였다. INCR로 채번한 정수를 score로 쓰면 동점 자체가 불가능해진다.
  //
  // ⚠️ 재입장 시 이전 admitted 키를 지운다(2026-08-07 실사용 중 발견) — 안 지우면
  // "허가받고도 아직 TTL(기본 8초)이 안 끝난 채로 대기열을 다시 join"하는 경우
  // (예: 방문자가 이벤트 상세를 나갔다 재진입) 새로 받은 순번(rank)은 무시되고
  // 예전 admitted=true가 그대로 응답에 실려, 방문자가 대기 없이 곧장 "허가됨"
  // 화면으로 튀어버리는 버그가 있었다. join은 "지금부터 새로 기다리겠다"는
  // 뜻이므로, 과거에 받은 허가는 여기서 확실히 무효화하는 게 맞다.
  async join(eventId: number, userId: number): Promise<void> {
    await this.redis.del(this.admittedKey(eventId, userId));
    const seq = await this.redis.incr(this.queueSeqKey(eventId));
    await this.redis.zadd(this.queueKey(eventId), 'NX', seq, String(userId));
    await this.redis.sadd(ACTIVE_QUEUES_KEY, String(eventId));
  }

  // 대용량 트래픽 테스트 이벤트 전용 진입(ADR 0016 백로그) — 대기열 자료구조
  // (queue:event:{id} ZSet, admitted 키)는 join()과 완전히 똑같이 공유하지만
  // (eventId가 다르니 어차피 안 섞인다), "어느 워커가 이 이벤트를 처리할지"를
  // 가르는 활성 목록만 다른 Set(LOAD_TEST_ACTIVE_QUEUES_KEY)에 등록한다 — 캐주얼
  // AdmissionProcessor와 LoadTestAdmissionProcessor가 같은 이벤트를 동시에
  // ZPOPMIN하는 경합을 원천 차단하기 위해서다.
  async joinLoadTest(eventId: number, userId: number): Promise<void> {
    await this.redis.del(this.admittedKey(eventId, userId));
    const seq = await this.redis.incr(this.queueSeqKey(eventId));
    await this.redis.zadd(this.queueKey(eventId), 'NX', seq, String(userId));
    await this.redis.sadd(LOAD_TEST_ACTIVE_QUEUES_KEY, String(eventId));
  }

  // 실제 예매 시도(관문 도전) 직전에 반드시 통과해야 하는 체크. 실사용자(컨트롤러)와
  // 가상 유저(DemoService) 둘 다 이 메서드 하나를 거친다 — 특수 경로를 만들지 않는다.
  async assertAdmitted(eventId: number, userId: number): Promise<void> {
    const admitted = await this.redis.exists(this.admittedKey(eventId, userId));
    if (!admitted) {
      throw new ForbiddenException('대기열 입장 후 이용하세요.');
    }
  }

  // 입장 처리 워커(AdmissionProcessor)가 실제로 하는 일 그대로를 계산에 반영한다 —
  // "초당 N명" 같은 연속 처리율 근사가 아니라, rank가 몇 번째 배치(ADMISSION_BATCH_SIZE명씩,
  // ADMISSION_INTERVAL_MS 주기)에서 빠지는지를 그대로 센다.
  private eta(rank: number | null): number | null {
    if (rank === null) return null;
    const batchesAhead = Math.ceil((rank + 1) / ADMISSION_BATCH_SIZE);
    return batchesAhead * (ADMISSION_INTERVAL_MS / 1000);
  }

  async status(eventId: number, userId: number): Promise<QueueStatus> {
    const [rank, admitted] = await Promise.all([
      this.redis.zrank(this.queueKey(eventId), String(userId)),
      this.redis.exists(this.admittedKey(eventId, userId)),
    ]);
    return { rank, admitted: admitted === 1, etaSeconds: this.eta(rank) };
  }

  // 폴링(1초 주기)만으로는 "대기 → 허가" 전환이 최대 1초 늦게 보인다. 확정 SSE(0006
  // 2.4)와 같은 이유로 방송국(QueueEventsService)을 함께 구독해, 이 유저가 허가받는
  // 순간 폴링 틱을 기다리지 않고 즉시 재조회해 흘려보낸다. 대기 중 rank가 계속
  // 바뀌는 것까지 매번 이벤트로 방송하긴 번거로워 그건 폴링에 맡긴다(ADR 0017
  // 백로그, 2026-08-15에서 결정한 범위).
  streamStatus(eventId: number, userId: number): Observable<MessageEvent> {
    const polling$ = timer(0, STATUS_POLL_INTERVAL_MS).pipe(
      switchMap(() => this.status(eventId, userId)),
    );
    const admitted$ = this.events
      .ofUser(eventId, userId)
      .pipe(switchMap(() => this.status(eventId, userId)));
    return merge(polling$, admitted$).pipe(
      map((status) => ({ data: status }) as MessageEvent),
    );
  }

  // ── 아래는 AdmissionProcessor 전용 — 대기열 앞에서 N명을 꺼내 허가하는 동작 ──

  async activeEventIds(): Promise<number[]> {
    const ids = await this.redis.smembers(ACTIVE_QUEUES_KEY);
    return ids.map(Number);
  }

  // LoadTestAdmissionProcessor 전용 — joinLoadTest()가 등록한 목록만 본다.
  async activeLoadTestEventIds(): Promise<number[]> {
    const ids = await this.redis.smembers(LOAD_TEST_ACTIVE_QUEUES_KEY);
    return ids.map(Number);
  }

  // ZPOPMIN은 [member1, score1, member2, score2, ...] 형태의 평평한 배열을 반환한다.
  async popNext(eventId: number, batchSize: number): Promise<number[]> {
    const popped = await this.redis.zpopmin(this.queueKey(eventId), batchSize);
    const userIds: number[] = [];
    for (let i = 0; i < popped.length; i += 2) {
      userIds.push(Number(popped[i]));
    }
    return userIds;
  }

  async admit(eventId: number, userId: number): Promise<void> {
    await this.redis.set(
      this.admittedKey(eventId, userId),
      '1',
      'PX',
      this.admissionWindowMs(),
    );
  }

  // 아직 입장 허가를 못 받고 대기열에 남아있는 인원 수(허가 전) — 데모 stats
  // 대시보드가 "지금 몇 명이 대기 중인지"를 보여주는 데 쓴다(2026-08-06).
  async size(eventId: number): Promise<number> {
    return this.redis.zcard(this.queueKey(eventId));
  }

  async deactivateIfEmpty(eventId: number): Promise<void> {
    const size = await this.redis.zcard(this.queueKey(eventId));
    if (size === 0) {
      await this.redis.srem(ACTIVE_QUEUES_KEY, String(eventId));
    }
  }

  // LoadTestAdmissionProcessor 전용 — 위와 동일한 로직, 다른 활성 목록을 정리한다.
  async deactivateLoadTestIfEmpty(eventId: number): Promise<void> {
    const size = await this.redis.zcard(this.queueKey(eventId));
    if (size === 0) {
      await this.redis.srem(LOAD_TEST_ACTIVE_QUEUES_KEY, String(eventId));
    }
  }

  // 데모/대용량 테스트 리셋 공통 — 아직 입장 허가를 못 받고 대기 중이던 사람들을
  // 리셋 시점에 함께 비운다. 이미 허가를 받아 admitted 키를 들고 있는 사람은
  // 그 키의 TTL(입장 허가창, 기본 8초)이 지나면 자연히 assertAdmitted에서
  // 막히므로 여기서 따로 안 지운다(짧은 TTL이라 유실돼도 무해). 이벤트가 어느
  // 활성 목록에 속했든(캐주얼/대용량) 한쪽엔 없어도 srem은 안전한 no-op이라
  // 호출부가 어느 쪽인지 몰라도 둘 다 지워서 안전하게 정리한다.
  async purge(eventId: number): Promise<void> {
    await this.redis.del(this.queueKey(eventId));
    await this.redis.srem(ACTIVE_QUEUES_KEY, String(eventId));
    await this.redis.srem(LOAD_TEST_ACTIVE_QUEUES_KEY, String(eventId));
  }
}
