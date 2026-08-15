import { ForbiddenException, Injectable, MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, timer } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { RedisService } from '../redis/redis.service';
import { ACTIVE_QUEUES_KEY } from './queue.constants';

// SSE 순번 확인 폴링 주기 — 0016 stats 대시보드와 같은 값(체감상 실시간, 구현은 단순).
const STATUS_POLL_INTERVAL_MS = 1_000;

// 한 스냅샷의 모양 — 대기 중이면 순번(0부터), 입장 허가를 받았으면 rank는 null이 되고
// admitted가 true로 바뀐다. 둘 다 null/false면 대기열에 없다(=한 번도 안 들어왔거나
// 허가창이 만료돼 밀려난 것).
export interface QueueStatus {
  rank: number | null;
  admitted: boolean;
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

  // NX(멤버가 없을 때만 추가) — 중복 클릭이 원래 진입 시각(순번)을 다시 지금으로
  // 밀어버리지 않게 한다.
  //
  // ⚠️ 재입장 시 이전 admitted 키를 지운다(2026-08-07 실사용 중 발견) — 안 지우면
  // "허가받고도 아직 TTL(기본 8초)이 안 끝난 채로 대기열을 다시 join"하는 경우
  // (예: 방문자가 이벤트 상세를 나갔다 재진입) 새로 받은 순번(rank)은 무시되고
  // 예전 admitted=true가 그대로 응답에 실려, 방문자가 대기 없이 곧장 "허가됨"
  // 화면으로 튀어버리는 버그가 있었다. join은 "지금부터 새로 기다리겠다"는
  // 뜻이므로, 과거에 받은 허가는 여기서 확실히 무효화하는 게 맞다.
  async join(eventId: number, userId: number): Promise<void> {
    await this.redis.del(this.admittedKey(eventId, userId));
    await this.redis.zadd(this.queueKey(eventId), 'NX', Date.now(), String(userId));
    await this.redis.sadd(ACTIVE_QUEUES_KEY, String(eventId));
  }

  // 실제 예매 시도(관문 도전) 직전에 반드시 통과해야 하는 체크. 실사용자(컨트롤러)와
  // 가상 유저(DemoService) 둘 다 이 메서드 하나를 거친다 — 특수 경로를 만들지 않는다.
  async assertAdmitted(eventId: number, userId: number): Promise<void> {
    const admitted = await this.redis.exists(this.admittedKey(eventId, userId));
    if (!admitted) {
      throw new ForbiddenException('대기열 입장 후 이용하세요.');
    }
  }

  async status(eventId: number, userId: number): Promise<QueueStatus> {
    const [rank, admitted] = await Promise.all([
      this.redis.zrank(this.queueKey(eventId), String(userId)),
      this.redis.exists(this.admittedKey(eventId, userId)),
    ]);
    return { rank, admitted: admitted === 1 };
  }

  streamStatus(eventId: number, userId: number): Observable<MessageEvent> {
    return timer(0, STATUS_POLL_INTERVAL_MS).pipe(
      switchMap(() => this.status(eventId, userId)),
      map((status) => ({ data: status }) as MessageEvent),
    );
  }

  // ── 아래는 AdmissionProcessor 전용 — 대기열 앞에서 N명을 꺼내 허가하는 동작 ──

  async activeEventIds(): Promise<number[]> {
    const ids = await this.redis.smembers(ACTIVE_QUEUES_KEY);
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

  // 데모 리셋(§DemoService.resetDemoEvent) 전용 — 아직 입장 허가를 못 받고
  // 대기 중이던 사람들을 리셋 시점에 함께 비운다. 이미 허가를 받아 admitted 키를
  // 들고 있는 사람은 그 키의 TTL(입장 허가창, 기본 8초)이 지나면 자연히
  // assertAdmitted에서 막히므로 여기서 따로 안 지운다(짧은 TTL이라 유실돼도 무해).
  async purge(eventId: number): Promise<void> {
    await this.redis.del(this.queueKey(eventId));
    await this.redis.srem(ACTIVE_QUEUES_KEY, String(eventId));
  }
}
