# 현재 상태 (기기 간 세션 인수인계용)

> **이 파일은 "지금 어디까지 됐고 다음은 뭔가"를 담는 항상 최신인 스냅샷 1장이다.**
> 세션 공유가 안 되는 두 기기(회사/집)가 이 파일로 싱크를 맞춘다.
> - **세션 시작 시**: 이 파일을 가장 먼저 읽고 "다음 할 일"부터 이어간다.
> - **세션 끝 / 커밋 전**: 이 파일을 **덮어써서** 최신 상태로 갱신한다. (시간순 이력·삽질은 `DEVLOG.md`, 결정 근거는 `decisions/`)

**마지막 업데이트:** 2026-07-21 (**W3 2.3 BullMQ 큐/워커 확정 흐름 구현·검증 완료**. **다음은 2.4 SSE**)

---

## ✅ 완료
- **W1 전체**: 스키마·마이그레이션·인증(회원가입/로그인/보호가드)·이벤트 CRUD·단위 테스트 8개. (자세한 건 DEVLOG.)
- **W2 전체**: 순진한 예매 → 초과판매(oversell) 재현 → 락 3종(비관적/낙관적/DB원자) → Redis 인메모리 원자 차감(5번째 전략) → k6 5전략 부하 비교(§8, redis 압도적 승자). 교훈: 병목은 DB가 아니라 **단일 재고 행 쓰기의 직렬화**. 문서 `docs/perf/2026-07-16-w2-lock-comparison.md`, ADR 0014.
- **W3 설계**: ADR 0015 확정 — 관문(Redis DECRBY) → **HELD 선기록(DB INSERT)** → 큐(BullMQ) → 즉시 응답 → 워커 HELD→CONFIRMED → SSE push. + HELD TTL 만료 + Redis 재구성. 2026-07-20 멱등성 부분 개정(관문이 INSERT보다 먼저라 재전송도 DECRBY를 더 깎음 → unique 위반 시 INCRBY 보상 + 성공 응답).
- **스키마 변경 (커밋됨)**: `Reservation`에 `idempotencyKey String`(필수) + `@@unique([userId, idempotencyKey])`. (`status`·`heldUntil`·인덱스는 W1에 이미 존재.)
- **✅ 마이그레이션 적용 완료 (2026-07-21, 커밋 1c0afd2)**: `20260720230857_add_reservation_idempotency_key`. `ALTER TABLE ADD COLUMN idempotencyKey NOT NULL` + `CREATE UNIQUE INDEX (userId, idempotencyKey)`. **이 기기 로컬 DB는 방금 생성돼 비어 있었으므로 A(reset) 불필요했음** — STATUS가 걱정한 "수만 행 충돌"은 다른 기기 얘기였다.
- **✅ W3 2.2 — HELD 선기록 흐름 구현·검증 (2026-07-21, 커밋 6c5ed23)**: `reservations.service.ts`에 `createHeld`(6번째 strategy `held`) 추가.
  - **두 방어막 분리** (이게 핵심 — 헷갈리기 쉬움): ① **관문 DECRBY 음수 = 재고부족(초과판매)** → INCRBY 보상 + 409. ② **HELD INSERT의 P2002 = 재전송(중복)** → INCRBY 보상 + 첫 예매 그대로 성공 반환(409 아님). **관문은 재전송을 못 잡는다** — 재전송도 재고 남으면 관문 통과 후 INSERT에서 P2002로 걸림.
  - **W2 5전략(naive~redis) 보존**: `idempotencyKey`가 NOT NULL이 되며 5곳 `reservation.create`가 깨져서, 서버가 `randomUUID()`로 자동 발급해 채움(멱등성 대상 아님, unique 충돌 회피용). 벤치 재현성 유지.
  - **DTO**: `idempotencyKey` optional(`@IsUUID`). `held`에서만 서비스가 "없으면 400" 강제.
- **✅ W3 2.3 — BullMQ 큐/워커 확정 흐름 구현·검증 (2026-07-21)**: HELD를 워커가 CONFIRMED로 뒤집는 파이프라인 후반부.
  - **개념 선정리**(사용자 자기설명 검증, DEVLOG 참고): 큐의 두 가치=신뢰성(job 영속·재시도=최종 일관성)+비동기 분리. INSERT는 동기·UPDATE만 큐인 이유="누가 기다리는가"(INSERT는 사용자가 재시도 엔진, UPDATE는 사용자 떠난 뒤라 job이 대신). HELD가 필요한 이유=미결제 상태라 CONFIRMED는 거짓, heldUntil 붙은 임시 확보(결제가 끼는 seam). job엔 id만(처리 시점 DB 재확인).
  - **구현**: `@nestjs/bullmq`+`bullmq`. `BullModule.forRootAsync`(app.module, REDIS_URL 파싱) + `registerQueue('confirm', attempts3·지수백오프·removeOnComplete)`. `ConfirmProcessor`(WorkerHost)가 `updateMany(WHERE status=HELD → CONFIRMED)`, count===0은 멱등 no-op. `createHeld`가 HELD 커밋 후 `queue.add('confirm',{reservationId})` → 즉시 HELD 반환. (같은 프로세스 워커 — ADR의 "별도 프로세스"는 운영 관심사라 후순위.)
  - **파일**: `confirm.processor.ts`(신규), `reservations.constants.ts`(큐 이름 상수, 신규), `app.module.ts`/`reservations.module.ts`/`reservations.service.ts` 수정.
  - **통합 테스트 4→6**: +확정(폴링 대기 후 CONFIRMED) +워커 멱등(확정된 예매에 job 중복 투입해도 1건). **전체 14개 그린.**

## 🔨 진행 중 / 막힌 것
- (막힌 것 없음. 2.3까지 완료.)
- **⚠️ 알려진 틈 — HELD 고아**: `createHeld`에서 `reservation.create` 커밋과 `queue.add` 사이에 크래시 나면 job 없는 HELD가 남는다(DB·큐 이중 쓰기라 비원자적). Outbox 패턴은 과함 → **2.5 TTL 회수 잡이 안전망(EXPIRE)** 으로 정리하기로 결정. (코드 주석에도 명시.)
- **⚠️ seed 스크립트가 없다**: DB가 비어 있어(admin·이벤트 없음) `held`를 **수동 e2e**로 돌리려면 회원가입·이벤트 생성이 선행돼야 한다. (통합 테스트는 setup에서 자체 생성하므로 무관.) 수동 확인이 잦아지면 seed 도입 고려.
- 장시간 테스트 시 JWT(1h) 만료 주의 → 재로그인으로 토큰 갱신.

## ▶️ 다음 할 일 (이 순서로)
1. ✅ ~~W1~~ / ✅ ~~W2 + ADR 0014~~ / ✅ ~~W3 설계 + ADR 0015~~ / ✅ ~~스키마 변경~~ / ✅ ~~마이그레이션~~ / ✅ ~~2.2 HELD 선기록 + 멱등성 보상~~ / ✅ ~~2.3 BullMQ 큐/워커 확정~~ — 여기까지 완료.
2. **W3 구현 (ADR 0015를 코드로) — 남은 순서:**
   1. **2.4 SSE**: 확정 시 클라이언트로 push(워커가 CONFIRMED 후 발행). → 검증: 상태 변화 실시간 전달.
   2. **2.5 안전장치**: HELD TTL 만료 회수(`heldUntil` 세팅 + 만료 스윕, **위 "HELD 고아"의 안전망 겸함**) + Redis 유실 재구성(`총재고−(HELD+CONFIRMED)`) 잡. → 검증: Redis flush 후 재구성값 정확. **여기서 `heldUntil`을 실제로 세팅**(2.2/2.3에선 사용처 없어 생략).
3. (선택) `Payment.idempotencyKey`도 단독 unique — 같은 유출 문제 가능. W3 결제 단계에서 재검토.
4. (선택) seed 스크립트(admin·이벤트 재현) — 수동 e2e가 잦아지면.

## 🖥️ 이 기기(현재) 로컬 환경 — 재세팅 시 주의
- **Node 버전**: 활성 `node`가 v22.12.0이면 pnpm(v22.13+ 요구)이 거부한다. **nvm의 v22.23.1 사용**: 명령 앞에 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"` 붙이거나 `nvm use v22.23.1`.
- **`.env`는 gitignore라 기기마다 새로 만든다**(이 기기엔 없어서 재생성함). 로컬 W2/W3용 값: `DATABASE_URL=postgresql://sunchak:sunchak@localhost:5432/sunchak?schema=public`, `REDIS_URL=redis://localhost:6379`, `JWT_SECRET`(로컬 임의값), `PORT=3001`. (docker-compose 계정과 일치.)
- **인프라 기동**: `cd infra && docker compose up -d --wait postgres redis`.
- **마이그레이션**: `migrate dev`는 대화형이라 비대화형(에이전트) 환경에서 막힌다. 우회 = `prisma migrate diff --from-url <DB> --to-schema-datamodel prisma/schema.prisma --script > migration.sql` → `prisma migrate deploy` → `prisma generate`. (사람이 직접 터미널에서 하면 `migrate dev`가 정상.)

## 🧪 테스트 실행법
- `cd apps/api && pnpm exec jest`(전체 14개) 또는 `pnpm exec jest reservations`(held 통합 6개). 사전조건: 로컬 PG·Redis 기동.
- ⚠️ **`pnpm exec`가 막히면**: bullmq의 선택적 네이티브 빌드(`msgpackr-extract`)가 스킵돼 pnpm의 실행 전 deps 점검이 실패할 수 있다. 우회 = 바이너리 직접 호출 `./node_modules/.bin/jest`, `./node_modules/.bin/tsc --noEmit`. (기능 무해 — JS로 폴백. 원하면 `pnpm approve-builds`로 승인.)
- W2 벤치: 서버(`pnpm start:dev`)+로컬 PG 기동, admin 계정 존재 확인 후 `ADMIN_PASSWORD=... bash apps/api/test/load/bench.sh`.

## 🖥️ 다른 기기에서 이어받는 법 (W2/W3는 로컬 DB!)
1. `git pull`
2. 이 파일 읽기 → "다음 할 일"부터.
3. **로컬 PG + Redis 기동**: `cd infra && docker compose up -d --wait postgres redis`.
4. `.env` 확인/생성(위 "이 기기 로컬 환경" 참고) → `cd apps/api && pnpm exec prisma migrate deploy && pnpm exec prisma generate`.
5. 서버: `pnpm start:dev`. 테스트: `pnpm exec jest`.
6. 더 깊은 맥락: `docs/DEVLOG.md` → `docs/decisions/` → `git log`.
