# 현재 상태 (기기 간 세션 인수인계용)

> **이 파일은 "지금 어디까지 됐고 다음은 뭔가"를 담는 항상 최신인 스냅샷 1장이다.**
> 세션 공유가 안 되는 두 기기(회사/집)가 이 파일로 싱크를 맞춘다.
> - **세션 시작 시**: 이 파일을 가장 먼저 읽고 "다음 할 일"부터 이어간다.
> - **세션 끝 / 커밋 전**: 이 파일을 **덮어써서** 최신 상태로 갱신한다. (시간순 이력·삽질은 `DEVLOG.md`, 결정 근거는 `decisions/`)

**마지막 업데이트:** 2026-08-01 (**W3 전체 완료 + W4 데이터 리셋/seed/진입 게이트/Google SSO 구현·검증 완료**. **다음은 W4 서버측 시뮬레이션(축 B-1)**)

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
- **✅ 공개 데모 모드 설계 확정 (2026-07-21, ADR 0016)**: 최종 산출물 = 무료 티어 위 공개 데모. 세 축 — ① **진입 게이트**(공유 비번 → API 계층 데모 토큰, 신뢰 경계는 백엔드. 로그인과 별개 막) ② **데모 장치**(서버측 부하 시뮬 + 실시간 stats 대시보드(SSE) + 리셋) ③ **한도 보호**(시뮬 상한+쿨다운). **리셋 = 자동 주기 + 수동 버튼(둘 다)**. **구현 시점 W4**(배포와 함께)지만 **2.4 SSE 설계 때 stats 스트림을 미리 염두**. 로드맵/기획안/`.env.example`(키 4개) 반영 완료.
- **✅ W3 2.4 — SSE 확정 push 구현·검증 (2026-07-22)**: 워커가 뒤집은 CONFIRMED를 SSE로 클라에 실시간 전달. 파이프라인 마지막 조각.
  - **방송국(이벤트 버스)**: 워커와 SSE 통로는 서로 **참조 없는(loose coupling)** 별개 실행 맥락 → 값 직접 못 넘김 → 프로세스 내 RxJS `Subject`를 경유. 워커=`publish`(next), SSE=`ofReservation(id)`(그 예약만 필터한 구독전용 Observable). NestJS `@Sse`가 반환한 Observable을 구독해 `data:...\n\n`로 push. **⚠️ 인메모리라 워커=웹서버 같은 프로세스일 때만** — 분리 시 Redis pub/sub 필요(후순위).
  - **경합 처리(핵심)**: 파이프라인이 빨라 클라가 스트림 여는 순간 워커가 **이미 확정 끝냈을 수** 있음 → `merge(future$=버스방송, current$=defer로 구독순간 DB조회해 이미 종료면 즉시 흘림)`. 워커가 "DB기록 후 방송" 순서 + merge가 버스부터 구독 → 누락 0. `take(1)`로 확정 1건 후 연결 종료.
  - **결제와의 관계(개념 정리)**: 지금 워커 즉시 flip은 **결제 stub**. 실제론 결제 완료(PG 웹훅)가 confirm job을 태우고, 그 자리에서 `publish` 한 줄만 있으면 됨(워커 코드 불변). SSE는 "누가 confirm을 일으켰든" 방송 하나만 들음.
  - **파일**: `reservation-events.service.ts`(신규, 버스), `reservation-stream.controller.ts`(신규, `@Controller('reservations')`+`@Sse(':id/stream')`), `confirm.processor.ts`/`reservations.service.ts`(`assertOwned`+`streamStatus`)/`reservations.module.ts` 수정.
  - **검증**: `async @Sse`가 안전한지 NestJS 소스로 확정(`Promise.resolve(result).then` + `.catch(reject)` → 정상 구독 / 예외는 헤더 전 404·403). **통합 6→9**(버스 필터링·따라잡기·HELD중 확정수신). **전체 17개 그린.**
  - **⚠️ 남은 틈**: 브라우저 `EventSource`는 `Authorization` 헤더 못 붙임 → 지금 JWT 가드 유지라 **프론트 붙일 때 쿼리파라미터 토큰/쿠키로 해결** 필요. 하트비트 없음(운영 후순위).
- **✅ W3 2.5 — HELD TTL 만료 회수 + Redis 재구성 구현·검증 완료 (2026-08-01) — W3 전체 완료**: 안전장치 2종, 서로 다른 트리거·계산.
  - **개념 정리(사용자 자기설명 검증, DEVLOG 참고)**: BullMQ delayed job(예매당 1개)이 아니라 **주기적 스윕(repeatable job)**을 택함 — `delay`는 "그 전엔 안 함"만 보장하지 정확한 시점을 보장 안 해, 선착순처럼 다수가 동시 만료되면 delayed job이 워커 동시성만큼 밀림. 벌크 UPDATE 1번은 건수 무관. **`UPDATE...RETURNING`**으로 "만료 대상 찾기"와 "상태 변경"을 원자적 한 문장으로(SELECT 후 UPDATE면 confirm 워커와 경합 재발 — `WHERE status=HELD`가 방어선). **DB 먼저, Redis 보정은 나중**(반대 순서면 크래시 시 초과판매 재발 가능). 재구성 잡은 "Redis가 죽었을 때만"이 아니라 **DB·Redis dual-write는 근본적으로 트랜잭션 못 묶어 항상 미세한 틈이 있음** → 서버 기동 시 1회가 아니라 **상시 주기적**.
  - **구현**: `HELD_TTL_MS`(5분, `reservations.service.ts`) + `createHeld`가 `heldUntil` 실제 세팅(2.2/2.3에선 생략했던 부분). 신규 `sweep.processor.ts`(30초 주기, `$queryRaw`로 원자적 EXPIRE + eventId별 합산 `INCRBY`), 신규 `reconcile.processor.ts`(1분 주기, Prisma `groupBy`로 `총재고−(HELD+CONFIRMED)` 계산 후 이벤트별 `SET`). 둘 다 `OnModuleInit`에서 자기 큐에 스스로를 `repeat` 등록(confirm과 달리 외부 producer 없음).
  - **삽질**: 통합 테스트 파일이 3개(reservations/sweep/reconcile)로 늘며 Jest 기본 병렬 실행이 같은 로컬 DB를 공유하는 파일들의 `beforeEach` 전체삭제를 서로 밟음 → `package.json` jest 설정에 **`maxWorkers: 1`** 추가(직렬 실행)로 해결.
  - **테스트**: 신규 2파일(sweep 3건 + reconcile 4건). **전체 17→24 그린.**
- **✅ W4 착수 — 데이터 리셋 + seed 구현·검증 완료 (2026-08-01, ADR 0016 축 C 부분 개정)**: STATUS의 오래된 "seed 없음" 틈을 해소.
  - **범위 조정**: 자동 주기/활동기반 리셋은 이번에 드롭 — **수동 리셋만**(`POST /demo/reset`). 필요해지면 나중에 추가(ADR 0016 개정 이력 참고).
  - **데모 이벤트 식별**: `Event.isDemo Boolean` 추가(마이그레이션 완료) — 로컬의 다른 테스트 이벤트와 안 섞이게.
  - **구현**: 신규 `demo/` 모듈. `DemoService.resetDemoEvent()`(예매 삭제→재고/Redis 원복→openAt·status 리셋)를 `prisma/seed.ts`(idempotent, 없으면만 생성)와 `POST /demo/reset` 엔드포인트가 공유. 리셋 엔드포인트는 **아직 가드 없음**(진입 게이트가 다음 작업이라 그때 보호 예정, 코드 주석에 명시).
  - **테스트**: 신규 `demo.service.spec.ts` 4건. **전체 24→28 그린.** curl로 실제 HTTP 경로도 수동 검증.
- **✅ W4 진입 게이트 구현·검증 완료 (2026-08-01, ADR 0016 축 A)**: 이 프로젝트의 첫 **전역 가드**.
  - **토큰**: 기존 `JwtService` 재사용(`{type:'demo'}` payload, 새 시크릿 불필요, `JWT_EXPIRES_IN` 그대로). `AuthModule`이 `JwtModule`을 `exports`하도록 수정.
  - **채널 분리**: 게이트 토큰은 `X-Demo-Token` 헤더(로그인 `Authorization`과 별개) — "게이트 ≠ 로그인"이 헤더 레벨까지 분리됨.
  - **구현**: `POST /demo/gate`(비번검증→토큰발급, `@Public()`으로 가드 우회) + `DemoGateGuard`(`APP_GUARD`로 전역 등록, `@Public()` 없는 모든 라우트에 적용) + `/health`에 `@Public()`. **`DEMO_GATE_PASSWORD` 미설정 시 게이트 자동 비활성화**(로컬 개발·기존 스크립트 안 깨지게).
  - **⚠️ 방문자 식별 방식 미정**: 게이트 설계 중 "방문자가 직접 예매 가능해야 한다"가 새로 나왔는데, 그 방식(로그인 없는 게스트 vs Google SSO 등)이 세 번 바뀌다 **오늘 범위에서 분리**됐다. 다음 세션에서 결정 필요(ADR 0013과 연관, 새 ADR 검토).
  - **테스트**: `DemoGateGuard` 순수 단위 테스트 6건(가짜 `ExecutionContext`, DB/HTTP 불필요) + `enterGate` 통합 테스트 3건. **전체 28→37 그린.** curl로 5단계 전체 흐름(공개→차단→거부→발급→통과) + 비번 미설정 시 자동 우회 수동 검증.
- **✅ 방문자 예매 인증 — Google SSO 구현·검증 완료 (2026-08-01)**: 방문자 식별 방식 논의(admin 불필요→게스트→Google SSO) 최종 확정.
  - **스키마**: `User.password String?`(nullable, 마이그레이션 완료) — Google 계정은 비밀번호 없음. `AuthService.login()`에 null-password 가드 추가(크래시 대신 401).
  - **구현**: `google.strategy.ts`+`GoogleAuthGuard`(신규) + `AuthController`에 `GET /auth/google`(리다이렉트 시작)·`GET /auth/google/callback`(토큰 발급, 프론트 없어 지금은 JSON 직접 반환) + `AuthService.findOrCreateGoogleUser()`. `@Public()` 데코레이터를 `demo/`→`common/decorators/`로 이동(auth에서도 필요해짐).
  - **⚠️ 게이트와의 구조적 충돌**: 브라우저 리다이렉트는 커스텀 헤더를 못 붙여 `/auth/google`·`/auth/google/callback`은 `@Public()`으로 게이트 우회(의도적 — 로그인 "시작"만 게이트 없이 가능, 실제 예매는 여전히 게이트+로그인 토큰 둘 다 필요).
  - **삽질**: `clientID`에 빈 문자열 fallback을 썼다가 `passport-oauth2`가 생성자에서 throw해 **앱 부팅이 죽는** 버그 발견 → `'not-configured'` 같은 비어있지 않은 플레이스홀더로 수정.
  - **새 env 3개**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`(`.env.example` 반영). 사용자가 Google Cloud Console에서 OAuth 클라이언트 직접 발급.
  - **테스트**: `auth.service.spec.ts` 4건 추가. **전체 37→41 그린.** 실제 Google 계정으로 브라우저 로그인 end-to-end 검증(토큰 발급 → `/auth/me` 통과 → DB에 `password IS NULL` 계정 생성 확인).

## 🔨 진행 중 / 막힌 것
- (막힌 것 없음.)
- 장시간 테스트 시 JWT(1h) 만료 주의 → 재로그인으로 토큰 갱신.

## ▶️ 다음 할 일 (이 순서로)
1. ✅ ~~W1~~ / ✅ ~~W2 + ADR 0014~~ / ✅ ~~W3 전체(설계+2.2~2.5) + ADR 0015~~ / ✅ ~~W4 데이터 리셋+seed~~ / ✅ ~~W4 진입 게이트~~ / ✅ ~~Google SSO~~ — 여기까지 완료.
2. **W4 서버측 부하 시뮬레이션 (축 B-1)** — 가상 유저 N명 투입 엔드포인트 + 상한(`DEMO_SIM_MAX_VU`)·쿨다운(Redis, `DEMO_SIM_COOLDOWN_MS`).
3. **W4 실시간 stats 대시보드 (축 B-2)** — 2.4의 `@Sse`+`Subject` 배관 재사용, 재고/HELD/CONFIRMED/큐 적체 스트리밍.
4. **W4 프론트엔드(apps/web)** — 게이트 화면 + Google 로그인 버튼 + 데모 컨트롤 화면. 백엔드 조각들이 갖춰진 뒤("서버 먼저" 원칙).
5. **배포** — Neon(이미 있음)·무료/저가 VM·Vercel 등. **배포 시 `GOOGLE_CALLBACK_URL`을 실제 도메인으로, Google Cloud Console의 승인된 리디렉션 URI도 함께 갱신 필요.**
6. (선택) `Payment.idempotencyKey`도 단독 unique — 같은 유출 문제 가능. 결제 단계에서 재검토(아직 Payment API 자체가 미구현).

## 🖥️ 이 기기(현재) 로컬 환경 — 재세팅 시 주의
- **Node 버전**: 활성 `node`가 v22.12.0이면 pnpm(v22.13+ 요구)이 거부한다. **nvm의 v22.23.1 사용**: 명령 앞에 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"` 붙이거나 `nvm use v22.23.1`.
- **`.env`는 gitignore라 기기마다 새로 만든다**(이 기기엔 없어서 재생성함). 로컬 W2/W3용 값: `DATABASE_URL=postgresql://sunchak:sunchak@localhost:5432/sunchak?schema=public`, `REDIS_URL=redis://localhost:6379`, `JWT_SECRET`(로컬 임의값), `PORT=3001`. (docker-compose 계정과 일치.)
- **⚠️ Google SSO는 이 기기의 Google Cloud Console에서 발급한 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`이 `.env`에 있어야 실제 로그인이 된다** — 미설정이어도 서버는 정상 기동하지만 `/auth/google` 시도 시 Google이 거부한다. **다른 기기에서 쓰려면**: 같은 Google Cloud 프로젝트의 OAuth 클라이언트에 그 기기의 콜백 URL(`http://localhost:3001/auth/google/callback`은 보통 기기 무관하게 동일)이 승인된 리디렉션 URI로 등록돼 있는지 확인 + Infisical에 값 동기화(ADR 0011, 아직 안 했으면 이 세션에서 수동으로 넣어야 함).
- **인프라 기동**: `cd infra && docker compose up -d --wait postgres redis`.
- **마이그레이션**: `migrate dev`는 대화형이라 비대화형(에이전트) 환경에서 막힌다. 우회(더 간단, 2026-08-01 확인) = `prisma migrate dev --name <이름> --create-only`(SQL만 생성, 적용 안 함) → `prisma migrate deploy` → `prisma generate`. (사람이 직접 터미널에서 하면 `migrate dev`가 정상.)
- **seed 스크립트 실행**: `prisma db seed`가 내부적으로 `ts-node`를 PATH에서 찾는데, `./node_modules/.bin/prisma`처럼 바이너리를 직접 호출하면 PATH에 `node_modules/.bin`이 없어 `ENOENT` 에러가 난다. `export PATH="$(pwd)/node_modules/.bin:$PATH"`를 먼저 붙이거나 `pnpm exec prisma db seed` 사용.

## 🧪 테스트 실행법
- `cd apps/api && pnpm exec jest`(전체 41개) 또는 `pnpm exec jest reservations`(held+SSE+sweep+reconcile 통합 16개) · `pnpm exec jest demo`(리셋+게이트 13개) · `pnpm exec jest auth`(회원가입/로그인/Google SSO 9개). 사전조건: 로컬 PG·Redis 기동.
- ⚠️ 실DB를 쓰는 통합 스펙 파일이 여러 개(reservations/sweep/reconcile/demo)라 **`maxWorkers: 1`(package.json jest 설정)로 직렬 실행** — 병렬 실행 시 서로의 `beforeEach` 전체삭제가 충돌한다(2.5에서 발견).
- ⚠️ **`pnpm exec`가 막히면**: bullmq의 선택적 네이티브 빌드(`msgpackr-extract`)가 스킵돼 pnpm의 실행 전 deps 점검이 실패할 수 있다. 우회 = 바이너리 직접 호출 `./node_modules/.bin/jest`, `./node_modules/.bin/tsc --noEmit`. (기능 무해 — JS로 폴백. 원하면 `pnpm approve-builds`로 승인.)
- W2 벤치: 서버(`pnpm start:dev`)+로컬 PG 기동, admin 계정 존재 확인 후 `ADMIN_PASSWORD=... bash apps/api/test/load/bench.sh`.

## 🖥️ 다른 기기에서 이어받는 법 (W2/W3는 로컬 DB!)
1. `git pull`
2. 이 파일 읽기 → "다음 할 일"부터.
3. **로컬 PG + Redis 기동**: `cd infra && docker compose up -d --wait postgres redis`.
4. `.env` 확인/생성(위 "이 기기 로컬 환경" 참고) → `cd apps/api && pnpm exec prisma migrate deploy && pnpm exec prisma generate`.
5. 서버: `pnpm start:dev`. 테스트: `pnpm exec jest`.
6. 더 깊은 맥락: `docs/DEVLOG.md` → `docs/decisions/` → `git log`.
