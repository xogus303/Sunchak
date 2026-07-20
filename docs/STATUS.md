# 현재 상태 (기기 간 세션 인수인계용)

> **이 파일은 "지금 어디까지 됐고 다음은 뭔가"를 담는 항상 최신인 스냅샷 1장이다.**
> 세션 공유가 안 되는 두 기기(회사/집)가 이 파일로 싱크를 맞춘다.
> - **세션 시작 시**: 이 파일을 가장 먼저 읽고 "다음 할 일"부터 이어간다.
> - **세션 끝 / 커밋 전**: 이 파일을 **덮어써서** 최신 상태로 갱신한다. (시간순 이력·삽질은 `DEVLOG.md`, 결정 근거는 `decisions/`)

**마지막 업데이트:** 2026-07-20 (ADR 0015 멱등성 개정 + 스키마 변경 완료. **다음은 마이그레이션 — 기존 행 처리 방식 선택부터**)

---

## ✅ 완료
- **W1 전체**: 스키마·마이그레이션·인증(회원가입/로그인/보호가드)·이벤트 CRUD·단위 테스트 8개. (자세한 건 이전 이력 참고 — DEVLOG)
- **W2 로컬 실험 환경**: 로컬 Postgres(docker-compose, :5432) 기동 + `apps/api/.env`의 `DATABASE_URL`만 로컬로 교체(Neon URL은 주석 보존) + `prisma migrate deploy` 반영. 서버는 `pnpm start:dev`(infisical 없이, 로컬 .env 자동 로드).
- **순진한 예매 API**: `reservations` 모듈 — `POST /events/:eventId/reservations`(JWT 필요). ①읽기 →②확인 →③절대값 덮어쓰기 차감 →④예매기록. 단일 요청 재고 5→4 정상 확인.
- **초과판매(oversell) 재현**: 재고 1개에 동시 30개 → 전부 201, **예매 30건/초과판매 29건**. 재고는 lost update로 `-29`가 아닌 `0`(더 은밀). 재현 스크립트는 scratchpad, 지연은 ②③사이 `setTimeout(50ms)`(학습용).
- **비관적 락(락 3종 중 1번)**: `$transaction` + `SELECT … FOR UPDATE`. 재고 행 잠금·직렬화. (git 63d0e79에 보존.)
- **낙관적 락(락 3종 중 2번)**: 재시도 루프 + `updateMany({where:{id,version}})` compare-and-swap. 락 없이 충돌 감지·재시도. (git 46a9a60에 보존.)
- **DB 원자연산(락 3종 중 3번)**: `updateMany({ where:{ eventId, remainingQty:{ gte } }, data:{ remainingQty:{ decrement } } })` 단일 문장. 재고 1→1건·재고 5→5건 정확 검증.
- **4전략 런타임 선택 리팩터**: `create()`가 `?strategy=naive|pessimistic|optimistic|atomic`로 분기(생략 시 atomic). 4방식 모두 현재 코드에 공존.
- **Redis 인메모리 원자 차감(5번째 전략)**: `RedisService`(ioredis, `@Global`, Prisma와 같은 생명주기) + `createRedis` — `DECRBY` 후 음수면 `INCRBY` 보상+409, 아니면 `reservation.create`만 DB에. 재고 seed는 bench.sh가 `redis-cli SET`으로.
- **k6 5전략 부하 비교(§8)**: VU30·15s·재고20만·hot row. **redis 압도적 승자**(RPS 9354·p95 4.4ms·완벽 정확 = atomic의 4.6배), atomic 2024(정확), naive lost update 3.3만, optimistic 재시도 8,262 실패, pessimistic 정확하나 느림. **교훈: 병목은 DB가 아니라 단일 재고 행 쓰기의 직렬화** — Redis로 빼면 DB는 병렬 INSERT만. 비용은 정합성(Redis↔DB). 문서: `docs/perf/2026-07-16-w2-lock-comparison.md`. 스크립트: `apps/api/test/load/`.
- **최종 예매 전략 ADR 0014 확정**: `docs/decisions/0014-reservation-strategy.md` — **Redis 인메모리 관문(`DECRBY`+보상) + DB 비동기 기록** 채택(DB 단독 폴백은 atomic). 근거 논리 사슬: hot row는 구조적으로 못 피함 → DB 직렬 1건당 비용 큼(행 락=Isolation·MVCC 새 버전·WAL fsync=Durability) → Redis는 그 보장 일부 포기(락·MVCC 없음 + fsync 비동기화)로 비용 최소화 → 대가는 정합성·유실. 개념(ACID/행락/MVCC/WAL·fsync)은 사용자 자기설명으로 검증 완료(DEVLOG 2026-07-18).
- **W3 정합성 설계 개념 완주 + ADR 0015 확정**: `docs/decisions/0015-reservation-consistency-design.md` — 관문(Redis DECRBY) → **HELD 선기록(DB INSERT)** → 큐(BullMQ) → 즉시 응답 → 워커가 HELD→CONFIRMED UPDATE → SSE push. + HELD TTL 만료 + Redis 재구성(`총재고 − (HELD+CONFIRMED)`). W3 3과제(어긋남/유실 재구성/멱등성) 개념적으로 전부 해결.
- **ADR 0015 멱등성 부분 개정 (2026-07-20)**: 구현 착수 직전 검토에서 오류 2건 발견·수정. ①**"워커 재시도의 중복 INSERT를 unique가 막는다"는 성립 안 함** — INSERT는 요청 경로에서 1회뿐이고 워커는 UPDATE만 함. 워커 UPDATE는 `WHERE status=HELD`라 본래 멱등이라 별도 장치 불필요. ②**멱등성 키는 서버가 아니라 클라이언트가 발급** — 서버는 "재전송"과 "진짜 두 번째 주문"을 요청 내용만으로 구분 불가(내용이 동일). ③신규: 관문이 INSERT보다 먼저라 **재전송도 `DECRBY`를 한 번 더 깎음** → 그대로 두면 주문 없이 재고 증발(조용함·누적·거짓 품절) → **unique 위반 시 `INCRBY` 보상 + 첫 요청과 같은 성공 응답**(409 아님). 개정 이력은 ADR 상단에 보존.
- **스키마 변경 (커밋됨, 마이그레이션은 미실행)**: `Reservation`에 `idempotencyKey String`(필수) + `@@unique([userId, idempotencyKey])` 추가. 복합인 이유는 **"같은 요청" = 같은 사람 + 같은 이름표**라는 정의를 그대로 옮긴 것(단독 unique는 남의 키와 충돌 → 타인 예매 유출 경로가 생김). ⚠️ `status`·`heldUntil`·`@@index([status, heldUntil])`은 **W1에 이미 존재**(이전 STATUS의 "status/heldAt 추가"는 착오).

## 🔨 진행 중 / 막힌 것
- **⛔ 마이그레이션이 막혀 있음 — 다음 세션 첫 작업.** `schema.prisma`는 고쳤지만 `migrate dev`를 아직 못 돌렸다. `reservations`에 **W2 벤치가 만든 수만 행**이 있어, 기본값 없는 NOT NULL 컬럼(`idempotencyKey`) 추가가 실패한다("기존 행에 뭘 넣지?"). 선택지:
  - **A) `prisma migrate reset`** (추천) — 로컬 DB 초기화 후 마이그레이션. 로컬 한정 쓰레기 데이터고 시드로 재현 가능. 공유 DB(Neon) 아니라 다른 기기 영향 없음.
  - B) 컬럼을 `String?`(nullable)로 — 데이터 보존하되 "이름표 없는 예매"가 허용돼 규칙에 구멍.
  - C) 임시 기본값 넣고 제거 — 실데이터 있을 때의 정공법이나 지금은 과함.
  - → **사용자 승인 대기 중.** A 선택 시: `cd infra && docker compose up -d postgres redis` → `cd apps/api && pnpm exec prisma migrate reset` → `pnpm exec prisma migrate dev --name add_reservation_idempotency_key`.
- 장시간 테스트 시 JWT(1h) 만료 주의 → 재로그인으로 토큰 갱신.

## ▶️ 다음 할 일 (이 순서로)
1. ✅ ~~W2 전체~~ / ✅ ~~ADR 0014~~ / ✅ ~~W3 설계 + ADR 0015(+ 2026-07-20 멱등성 개정)~~ / ✅ ~~스키마 변경(코드)~~ — 여기까지 완료.
2. **W3 구현** (ADR 0015를 코드로) — 이 순서로:
   1. **마이그레이션 실행** ← ⛔ 위 "막힌 것"의 A/B/C 선택부터. → 검증: 마이그레이션 적용·Prisma Client 재생성.
   2. **HELD 선기록**: 요청에서 클라이언트 발급 멱등성 키 수신(DTO) → 관문(DECRBY) 통과 즉시 `status=HELD` INSERT. **P2002(재전송) 시 `INCRBY` 보상 + 기존 예매를 그대로 성공 응답**(409 아님). → 검증: 같은 키 2회 요청 시 예매 1건 유지 + Redis 재고가 1만 깎였는지(보상 확인).
   3. **BullMQ 큐/워커**: 큐 모듈 + 워커가 `WHERE status=HELD`로 CONFIRMED UPDATE(재실행 시 0건 = 본래 멱등). → 검증: job 처리 후 CONFIRMED, 같은 job 2회에도 1건 유지.
   4. **SSE**: 확정 시 클라이언트로 push. → 검증: 상태 변화가 실시간 전달되는지.
   5. **안전장치**: HELD TTL 만료 회수 + Redis 유실 재구성(`총재고−(HELD+CONFIRMED)`) 잡. → 검증: Redis flush 후 재구성값 정확.
3. (선택) `Payment.idempotencyKey`도 단독 unique — 같은 유출 문제 가능. W3 결제 단계에서 재검토.
4. (선택) 회차 평균·VU 스윕(10/50/100)으로 벤치 정밀화.

## 🧪 W2 벤치 실행법
- 서버(`pnpm start:dev`)+로컬 PG 기동, admin 계정 존재 확인 후:
  `ADMIN_PASSWORD=... bash apps/api/test/load/bench.sh` (VUS/DUR/STOCK 환경변수로 조절).

## 🧪 W2 재현/검증 스크립트 (scratchpad, git 미포함)
- `oversell.sh` — 재고 1·동시 30 고정.
- `oversell_n.sh <재고> <동시수>` — 파라미터화(예: `oversell_n.sh 5 30`).
- 사전조건: 로컬 서버 기동 + `/tmp/token.txt`에 유효 토큰(admin 로그인).

## 🖥️ 다른 기기에서 이어받는 법 (W2는 로컬 DB!)
1. `git pull`
2. 이 파일 읽기 → "다음 할 일"부터.
3. **로컬 PG + Redis 기동**: `cd infra && docker compose up -d postgres redis` → `cd apps/api && pnpm exec prisma migrate deploy`.
   - ⚠️ `apps/api/.env`의 `DATABASE_URL`이 로컬(`localhost:5432`)인지 확인. W2는 로컬, 공유 dev(Neon)로 돌아갈 땐 주석의 Neon URL로 교체.
   - Redis는 `redis` 전략(5번째)·벤치에 필요. `.env`의 `REDIS_URL=redis://localhost:6379` 확인.
4. 서버: `pnpm start:dev` (W2는 infisical 불필요 — 로컬 .env가 JWT_SECRET 등 다 제공).
5. 더 깊은 맥락: `docs/DEVLOG.md` → `docs/decisions/` → `git log`.
