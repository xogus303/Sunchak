# 현재 상태 (기기 간 세션 인수인계용)

> **이 파일은 "지금 어디까지 됐고 다음은 뭔가"를 담는 항상 최신인 스냅샷 1장이다.**
> 세션 공유가 안 되는 두 기기(회사/집)가 이 파일로 싱크를 맞춘다.
> - **세션 시작 시**: 이 파일을 가장 먼저 읽고 "다음 할 일"부터 이어간다.
> - **세션 끝 / 커밋 전**: 이 파일을 **덮어써서** 최신 상태로 갱신한다. (시간순 이력·삽질은 `DEVLOG.md`, 결정 근거는 `decisions/`)

**마지막 업데이트:** 2026-08-06 (**"입장 대기중" 지표 추가** — 입장 대기열(ADR 0017)에서 아직 허가를 못 받은 인원 수를 처음으로 노출(`QueueService.size()`+`DemoStats.admissionQueueCount`). 실서버로 40명 투입 1초 후 `admissionQueueCount:20, abandonedCount:4`(첫 배치 20명 중 정확히 20% 포기)가 실시간으로 보이는 것 확인. 그 직전엔 이벤트 상세 페이지에 예매+판매현황+가상유저투입을 한 화면에 합치고 "포기(abandoned)" 지표를 신설해 `투입 인원수 = paid+failed+soldOut+abandoned` 등식이 실측으로 맞아떨어지는 것 확인. 그 전엔 이벤트 목록 별도 페이지 분리 + 결제 TTL 5분→30초 단축 + `demo` 도메인 개념 정리, 그 이전엔 실사용 중 발견한 버그 3건(BullMQ 스케줄러 파괴/가상유저 결제 누락/리셋이 대기열 안 비움) 수정 완료. **다음은 배포(6개 조각)뿐 — PRD 갭 전부 처리 완료**)

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
- **✅ W4 서버측 부하 시뮬레이션 구현·검증 완료 (2026-08-05, ADR 0016 축 B-1, 같은 날 개정)**: "가상 유저 N명 투입" 버튼의 백엔드.
  - **설계 확정(ADR 0016 2026-08-05 개정 참고)**: 투입 리듬=묶음(batch) 발사(20명×300ms 간격, 순수 동시/순수 순차 둘 다 이 프로젝트 목적에 안 맞아 절충), 가상 유저=실제 `User` 레코드 생성(`Reservation.userId`가 FK라 가짜 id 불가), 쿨다운=백엔드 Redis 강제 유지(신뢰 경계 원칙), 가상 유저는 이메일 접두사(`sim-`)로 식별해 리셋 시 함께 삭제.
  - **구현**: `ReservationsModule`이 `ReservationsService`를 `exports` → `DemoService`가 실제 파이프라인(`create(..., 'held', ...)`)을 그대로 재사용(시뮬 전용 우회 경로 없음, 진짜 동시성 경합 재현). `DemoService.simulateLoad()`(상한 검사→Redis `SET NX PX` 쿨다운→202 즉시 응답→`void`로 fire-and-forget 배치 투입) + `runSimulationBatches`/`injectVirtualUser`(재고 소진은 정상 시나리오로 조용히 넘김). `resetDemoEvent()`에 `sim-` User 정리 추가. `POST /demo/simulate` 신규(전역 게이트 가드로 이미 보호).
  - **테스트**: `demo.service.spec.ts` 4건 추가(상한 400, 정상 202+백그라운드 투입 확인, 쿨다운 429, 리셋 시 `sim-`만 삭제). **전체 41→45 그린.** 실서버 e2e 수동 검증도 완료(45명 시뮬 → Redis 재고 100→55, 45건 전부 CONFIRMED, `sim-` User 45건 생성 → 리셋 후 전부 원복 확인).
  - **아직 결과를 볼 방법이 curl/DB 조회뿐** — 축 B-2(stats SSE)가 붙어야 방문자가 이 과정을 실시간으로 지켜볼 수 있다.
- **✅ W4 실시간 stats 대시보드 구현·검증 완료 (2026-08-05, ADR 0016 축 B-2, 같은 날 개정)**: 축 B-1 시뮬레이션 결과를 실시간으로 보여주는 화면의 백엔드.
  - **설계 확정**: 이벤트 기반(2.4 방식)은 소스가 3개(Redis 재고·DB HELD/CONFIRMED·BullMQ 큐 적체)라 W3 기존 코드 여러 곳을 건드려야 해서, 대신 **1초 주기 폴링 스냅샷**으로 결정(기존 코드 무변경).
  - **구현**: `DemoModule`이 `confirm` 큐를 추가로 `registerQueue`해 `DemoService`가 `getWaitingCount()`/`getActiveCount()`로 적체를 읽음(job 투입은 안 함). `streamStats()`(이벤트 존재 1회 확인 후 `timer(0,1000)`+`switchMap`) + `getStats()`(Redis·Prisma groupBy·큐 카운트 병렬 조회) + `GET /demo/stats/stream`(`@Sse`, 전역 게이트 가드로 보호, JWT 불필요).
  - **테스트**: 2건 추가(404, 스냅샷 값 일치 — 큐는 `getQueueToken`으로 목 처리). **전체 45→47 그린.** 실서버 e2e: 리셋 후 SSE 스트림 열어두고 60명 시뮬 투입 → 재고/HELD/CONFIRMED/큐 적체가 실시간으로 변하는 걸 그대로 확인(재고 100→40, CONFIRMED 0→55→60 등).
  - **발견(보류)**: `simulateLoad()`가 쿨다운을 이벤트 존재 확인보다 먼저 걸어서, 데모 이벤트가 없는 상태(seed 전)에서 호출하면 404를 받으면서도 쿨다운은 소비됨. 사소한 엣지케이스라 지금은 기록만.
  - **W4 백엔드 데모 조각(게이트·리셋·시뮬·stats) 전부 완료.**
- **✅ W4 프론트엔드 착수 — 워크스페이스 신설 + 쿠키 기반 인증 전환 (2026-08-05)**: apps/web을 실제로 만들기 시작.
  - **pnpm 워크스페이스**(ADR 0012가 이 시점을 예정해둠): 루트 `package.json`+`pnpm-workspace.yaml`, `apps/api`/`apps/web` → `@sunchak/api`/`@sunchak/web`, lockfile 통합. `apps/api/package.json`의 중복 `packageManager` 필드 제거(안 지우면 워크스페이스인데도 로컬 lockfile이 계속 되살아남 — 삽질 후 발견).
  - **`apps/web` 스캐폴딩**: Next.js 16(App Router)+TypeScript+Tailwind+TanStack Query(`Providers` 배선 완료). 이 Next.js 버전은 학습 데이터보다 최신이라 실제 문서(`node_modules/next/dist/docs/`)를 참조해가며 작업 필요.
  - **SSE 인증을 쿠키(HttpOnly) 기반으로 전환**(기존 `X-Demo-Token`/`Authorization` 헤더 방식은 브라우저 `EventSource`가 커스텀 헤더를 못 붙여 그대로는 작동 안 함): `cookie-parser`+CORS(`credentials:true`) 추가, `JwtStrategy`/`DemoGateGuard`가 쿠키 우선·헤더 폴백, `login`/`enterGate`/Google 콜백이 쿠키도 함께 심음(Google 콜백의 오래된 "프론트 없어 JSON 임시 반환" TODO 해소 — 이제 실제로 `WEB_APP_URL`로 리다이렉트).
  - **⚠️ 배포 시 손볼 것**: 로컬은 포트만 다르지만 배포 시 프론트/백엔드가 다른 도메인이 되면 쿠키에 `SameSite=None`+`Secure`(HTTPS 필수)가 강제됨 — `common/auth-cookie.ts`에 `NODE_ENV` 분기를 이미 심어뒀으니 배포 시 그 분기가 제대로 걸리는지만 확인.
  - **새 env**: `WEB_APP_URL`.
  - **검증**: 전체 47개 테스트 그린(컨트롤러의 쿠키 로직은 서비스 계층 테스트라 영향 없음) + 실서버 e2e로 **쿠키만(헤더 없이)** 게이트·로그인·SSE 스트림이 전부 통과하는 것 확인.
- **✅ W4 프론트 실제 화면 구현·검증 완료 (2026-08-06)**: 게이트→Google 로그인→데모 대시보드 흐름 전체.
  - **화면 흐름**: `page.tsx`가 상태 하나(`checking/gate/login/dashboard`)로 세 화면을 조건 렌더링. `GateForm`(비번→`POST /demo/gate`) → 성공 시 재확인 → 로그인 안 됐으면 `Google로 로그인` 버튼(`<a href={API}/auth/google>`, 실제 페이지 이동이어야 OAuth 리다이렉트 체인이 작동) → 로그인 완료 시 `DemoDashboard`(시뮬 투입 폼 + SSE 스탯 4종 타일).
  - **게이트/로그인 상태 판별(설계 결정, 사용자 확인받음)**: 전용 상태 엔드포인트를 새로 만들지 않고 기존 `GET /auth/me`를 재사용 — 게이트 실패(한글 메시지)와 JWT 실패(`"Unauthorized"`) 메시지 문자열 차이로 구분(`page.tsx`의 `checkStatus`). 백엔드 에러 문자열에 약하게 결합되는 트레이드오프를 인지하고 진행.
  - **stats 대시보드는 dataviz 스킬 참고**: "헤드라인 숫자 몇 개"는 차트가 아니라 KPI row(스탯 타일)라는 판단 기준 적용. 색은 텍스트에 안 쓰고 재고 소진(매진) 같은 실제 상태에만 status 팔레트(`#d03b3b`) + 라벨 병기(색 단독 금지 규칙).
  - **새 파일**: `apps/web/src/lib/api.ts`(credentials 강제 fetch 헬퍼), `app/gate-form.tsx`, `app/demo-dashboard.tsx`, `app/page.tsx` 교체. `.env.example`에 `NEXT_PUBLIC_API_URL` 추가.
  - **검증 방법**: 이 저장소에 브라우저 구동 전용 스킬이 없어 Playwright(스크래치패드에 임시 설치, `chromium.launch`)로 헤드리스 e2e 2건 실행 — ① 첫 진입 시 게이트 폼 → 통과 후 로그인 버튼까지(콘솔 401은 상태 확인용 정상 응답, 에러 아님), ② 브라우저 컨텍스트에 실제 쿠키를 심어(게이트+회원가입/로그인) 대시보드까지 도달 → "가상 유저 15명 투입" 클릭 → 재고 100→85, CONFIRMED 0→15로 SSE가 실시간 반영되는 것 스크린샷으로 확인. 종료 후 `POST /demo/reset`으로 데이터 원복.
  - **이 검증을 위해 로컬 `.env`에 `DEMO_GATE_PASSWORD="sunchak-demo"`를 추가**(미설정이면 게이트가 자동 비활성화돼 게이트 화면 자체를 테스트할 수 없었음 — 값 자체는 비밀 아님, 필요시 바꿔도 됨).
- **✅ 프론트 테스트 프레임워크(Vitest+RTL) 도입 + 이번 3개 컴포넌트 소급 작성 완료 (2026-08-06)**: CLAUDE.md §7 요구사항 충족.
  - **설치**: `vitest`+`@vitejs/plugin-react`+`jsdom`+`@testing-library/react`+`@testing-library/dom`+`@testing-library/jest-dom`(devDependency, apps/web). `vitest.config.mts`(jsdom 환경, `resolve.tsconfigPaths:true`로 `@/*` 별칭 해석 — 별도 플러그인 없이 Vite 8 내장 옵션 사용). `vitest.setup.ts`가 jest-dom 매처 등록 + `afterEach(cleanup)`(globals:true를 안 켰으므로 RTL 자동 cleanup이 안 붙어 직접 등록 필요 — 안 하면 테스트 간 DOM 잔존으로 "여러 개 찾힘" 에러). `package.json`에 `"test": "vitest run"`.
  - **작성한 테스트**: `gate-form.test.tsx`(3) 성공/실패/버튼 비활성화, `demo-dashboard.test.tsx`(3) SSE 스냅샷 반영·시뮬 요청·에러 표시, `page.test.tsx`(3) 게이트/로그인/대시보드 3분기. `EventSource`가 jsdom에 없어 `src/test/fake-event-source.ts`(최소 흉내 클래스, 2개 테스트 파일이 공유)로 대체. **전체 9개 그린.**
  - **실행법**: `cd apps/web && pnpm test`.
- **✅ 실제 "내 예매" 기능 추가 — 방문자 본인이 직접 예매 (2026-08-06)**: 데모 대시보드가 지금까지 "관찰"(가상 유저 시뮬 + 통계)만 가능했고, 로그인한 방문자 본인이 티켓을 예매하는 화면이 없다는 걸 사용자가 직접 써보고 지적함 — ADR 0014/0015가 만든 실제 예매 파이프라인(HELD→큐→확정→SSE)을 프론트에서 한 번도 호출하지 않고 있었다.
  - **구현**: 신규 `app/booking-form.tsx`. 마운트 시 `GET /events`로 `isDemo` 이벤트를 찾아 `eventId` 확보 → 수량 입력 + "예매하기" → `POST /events/:eventId/reservations?strategy=held`(idempotencyKey는 `crypto.randomUUID()`로 클릭마다 새로 발급) → 응답의 `reservation.id`로 `GET /reservations/:id/stream`(SSE) 구독해 HELD→CONFIRMED 전환을 실시간 반영. `strategy`는 UI로 고르게 하지 않고 `held` 고정(이 데모의 목적이 ADR 0015 파이프라인을 보여주는 것이므로 — 사용자 확인받음). `DemoDashboard` 상단에 배치.
  - **실서버 검증**: 실제로 예매→확정까지 됨. **로컬 환경에서 관문→HELD→큐→워커 확정까지가 사람이 인지하기 어려울 만큼 빨라(수백ms 내) "HELD" 문구가 화면에 거의 안 보이고 곧바로 "확정"으로 넘어간다** — 버그가 아니라 로컬 워커 지연이 거의 없기 때문(배포 후 실제 네트워크·부하가 있으면 HELD 구간이 더 눈에 보일 수 있음).
  - **테스트**: `booking-form.test.tsx` 2건(확정 흐름, 재고부족 에러). `demo-dashboard.test.tsx`/`page.test.tsx`의 대시보드 분기 테스트도 `BookingForm`이 추가로 `/events`를 호출하므로 mock을 보강함. **`apps/web` 테스트 9→11개 그린.**
- **✅ 선착순 입장 대기열 구현·검증 완료 (2026-08-06, ADR 0017)**: "이 프로젝트 원래 목적이 뭐였나"를 사용자가 다시 짚으면서 시작 — PRD(`02_서비스_기획안.md`) 원안의 "대기열에서 실시간 순번을 보며 기다린다"가 ADR 0014/0015 구현 중 "즉시 판정 관문"으로 조용히 대체된 걸 재확인.
  - **핵심 설계**: 관문(0014)과 대기열을 별도 계층으로 분리 — 대기열은 "언제 관문에 도전할 자격을 주는가"만 관장, 관문·HELD·확정·SSE는 무변경. Redis Sorted Set `queue:event:{id}`(FIFO) + BullMQ repeatable job(`AdmissionProcessor`, 2초 주기 20명씩 `ZPOPMIN`) + `admitted:event:{id}:{userId}` TTL 키(sweep 잡 없이 Redis 자연 만료 — 재고를 아직 안 건드린 상태라 유실돼도 무해). `QueueService.assertAdmitted()` 한 곳을 실사용자(컨트롤러)·가상 유저(데모 서비스) 둘 다 통과.
  - **"대기열이 관문보다 얼마나 강력한가" 논의에서 나온 핵심 교정**: 대기열은 관문의 처리량을 올리지 않는다 — 오히려 **의도적으로 입장 속도를 늦추는 장치**(다운스트림 보호+낭비 방지+재시도 폭탄 억제). 이 프로젝트 실사용자는 소수뿐이라 대기열의 진짜 목적은 방어가 아니라 **PRD 학습 포인트 완결 + 포트폴리오 서사 확장**임을 ADR에 명시.
  - **가상 유저 현실성**: 입장 허가를 받아도 20% 포기 + 랜덤 지연 후 시도(사용자 요청) — 특수 코드 경로 없이 실사용자와 같은 `assertAdmitted`를 통과.
  - **⚠️ 삽질(실측으로 발견)**: 허가창(30초→8초로 축소)과 가상 유저 랜덤 지연 범위(1~35초, 원래 30초 창 기준)를 같이 안 맞춰서 30명 시뮬레이션 시 확정이 5명뿐(기대 밖). 두 시간 상수는 독립적으로 못 정한다는 교훈 — 지연 범위(0.5~10초)를 허가창(8초)보다 살짝만 넓게 재조정 → 30명 중 22명 확정(~73%)으로 재검증. 코드 기본값·`.env.example`·ADR 수치 모두 정정 완료.
  - **새 모듈**: `apps/api/src/queue/`(`queue.service.ts`/`queue-events.service.ts`/`admission.processor.ts`/`queue.controller.ts`/`queue.module.ts`). `reservations.controller.ts`(strategy=held일 때만 체크, W2 벤치마크 무영향), `demo.service.ts`(가상 유저 대기열 경유). 새 env 4개: `QUEUE_ADMISSION_WINDOW_MS`, `DEMO_SIM_ABANDON_PROBABILITY`, `DEMO_SIM_MIN_BOOKING_DELAY_MS`, `DEMO_SIM_MAX_BOOKING_DELAY_MS`.
  - **테스트**: `queue.service.spec.ts`(8) · `admission.processor.spec.ts`(4) · `reservations.controller.spec.ts`(3, 이 프로젝트 첫 컨트롤러 단위 테스트) · `demo.service.spec.ts`+2. **API 47→64 그린.** 프론트 `booking-form.tsx`가 대기열 상태까지 한 패널에서 표현(`idle→queued→admitted→held→confirmed/expired/error`) + 신규 테스트 3건. **web 9→12 그린.**
  - **실서버 e2e**: 실제 로그인 사용자로 대기열 입장→순번→입장 허가→예매→확정 전 흐름 확인 + 가상 유저 30명으로 파라미터 버그 실측 발견·재검증.
  - **⚠️ 아직 안 건드린 PRD 갭(대기열 외, 당시 기준)**: 모의결제·오픈 시각 검사·이벤트 목록/상세 화면·내 예매 내역·관리자 대시보드. 이 중 모의결제는 바로 다음 세션에서 완료(아래 참고).
- **✅ 모의 결제 구현·검증 완료 (2026-08-06, ADR 0018)**: PRD가 요구한 "모의 결제 버튼 + 비동기 pending→done"을 완성 — 지금까지 워커가 결제 없이 HELD를 곧바로 CONFIRMED로 뒤집던 "결제 stub"(0015가 스스로 예고해둔 자리)을 실제로 채움.
  - **핵심 변경**: `createHeld()`가 더 이상 confirm job을 즉시 넣지 않는다. 대신 "결제하기" 클릭(`POST /reservations/:id/pay`)이 새 `payment` 큐에 job을 넣고, `PaymentProcessor`가 80%/20% 확률로 성공/실패를 판정 — 성공하면 **기존 `confirm` 큐에 job만 투입**(`ConfirmProcessor` 완전 재사용, 무변경), 실패하면 Reservation을 CANCELLED로 바꾸고 Redis 재고를 즉시 반환(사용자 확인 후 채택 — HELD TTL 만료 대기 대신 즉시).
  - **`Payment.idempotencyKey` 백로그 항목 해소**: 재검토 결과 실제 버그 아님으로 결론(`Payment.reservationId`가 이미 `@unique`라 재시도 방어가 그걸로 충분) — ADR 0018에 근거 기록.
  - **새 파일**: `apps/api/src/reservations/`에 `payments.service.ts`·`payments.controller.ts`(`POST /reservations/:id/pay`)·`payment.processor.ts`(신규 `payment` 큐). 프론트 `booking-form.tsx`에 HELD 이후 "결제하기" 버튼 + PENDING 표시 + CONFIRMED/CANCELLED 분기 추가(대기열~결제~확정까지 한 패널, 화면 전환 없음 — 기존 원칙 유지).
  - **기존 테스트 갱신**: `reservations.service.spec.ts`의 "HELD 접수 후 자동 확정" 전제 테스트들을 "confirm job을 직접 넣어(=결제 성공 흉내) 확인"으로 수정 + "결제 없이는 자동 확정 안 됨" 회귀 테스트 추가. `Payment`가 `Reservation`에 FK를 걸게 되며 여러 스펙 파일의 `beforeEach` 정리 순서(`payment.deleteMany()`를 `reservation.deleteMany()`보다 먼저)도 함께 고쳤다.
  - **신규 테스트**: `payments.service.spec.ts`(4) · `payment.processor.spec.ts`(3, 성공/실패/이중반환 방지). **API 65→72 그린.** 프론트 결제 분기 테스트 2건 추가. **web 11→13 그린.**
  - **⚠️ 후속 발견·수정 (2026-08-06, 사용자가 브라우저로 직접 써보다 리셋이 500으로 죽는 걸 발견)**: `resetDemoEvent()`가 `reservation.deleteMany()`를 하는데, 이번에 추가된 `Payment→Reservation` FK 때문에 **결제 기록이 하나라도 있으면 그대로 P2003(FK 위반)으로 죽었다** — 테스트 파일들의 정리 순서는 고쳤지만 정작 프로덕션 코드인 이 메서드는 빠뜨렸던 것. `payment.deleteMany({ where: { reservation: { eventId } } })`를 `reservation.deleteMany()` 앞에 추가해 해결. 회귀 테스트 1건 추가(`demo.service.spec.ts`, "결제 기록이 있는 예매도 FK 위반 없이 함께 삭제된다"). **API 72→73 그린.**
  - **⚠️ 삽질 — 이번 세션 최대 시간 소모**: 백엔드 테스트가 이유 없이 SSE 관련 1건만 계속 타임아웃 → 원인은 이번 세션 동안 여러 번 `nohup pnpm start:dev &`로 띄운 백엔드가 **좀비로 5개나 누적**돼 있었던 것. `pnpm start:dev`는 래퍼고 진짜 서버(BullMQ 워커 포함)는 자식 `nest.js start --watch`인데, **포트 점유자만 죽이면 이 자식이 포트 없이도 Redis에 계속 붙어 job을 가로챈다** — DB는 (다른 프로세스가) 맞게 바꿔놔서 더 헷갈렸다. 해결·재발 방지 커맨드는 "테스트 실행법" 참고.
  - **실서버 e2e**: 게이트→로그인→대기열→예매→결제를 5회 반복 → 4번 확정/1번 취소(실측 80%와 근접) 둘 다 실제로 확인, 콘솔 에러 0.
- **✅ 이벤트 목록/상세 + 판매 현황 통합 구현·검증 완료 (2026-08-06)**: 남은 PRD 갭 재검토(직전 대화)에서 확정한 두 항목을 같이 처리.
  - **이벤트 목록/상세**: `prisma/seed.ts`에 정적 마감(`SOLD_OUT`, `isDemo:false`) 이벤트 2개 추가 — `resetDemoEvent()`는 `isDemo:true` 하나만 대상이라 이 둘은 절대 안 건드림(편리성 기준으로 택한 설계, 사용자 확인). 신규 `event-list.tsx` — 목록과 상세(제목/설명/가격/상태)를 화면 하나로 합침(이벤트가 몇 개뿐이라 별도 상세 페이지 불필요). 상태별 라벨(판매중/매진/오픈 예정/종료) + 색(판매중=good, 매진=critical, 나머지 중립).
  - **판매 현황 통합**: `DemoStats`에 `paidCount`/`failedCount` 추가(`Payment` 테이블 `groupBy`). 별도 관리자 화면 없이 기존 공개 stats 대시보드에 타일 2개만 추가(`grid-cols-3`로 6타일). 헤딩 "실시간 판매 현황" 추가.
  - **테스트**: `event-list.test.tsx`(1) 신규. `demo.service.spec.ts`의 stats 테스트를 CANCELLED+Payment 2건(PAID/FAILED) 포함하도록 갱신. **API 73개 유지(기존 테스트 보강), web 13→14 그린.**
  - **⚠️ 환경 삽질**: 프론트 테스트가 전부 `React.act is not a function`으로 깨짐 → 이 세션의 bash 환경에 `NODE_ENV=production`이 새어들어와 react-dom이 production 빌드(act 없음)로 로드된 것. `unset NODE_ENV` 또는 `NODE_ENV=test`로 덮어써서 해결(코드 문제 아님, "테스트 실행법" 참고).
  - **실서버 e2e**: 이벤트 목록 4개(매진 2·오픈예정 1·판매중 1)와 통합 대시보드 6타일이 실제로 정상 렌더되는 것 스크린샷으로 확인, 콘솔 에러 0.
- **✅ 실사용 중 발견한 심각한 버그 2건 수정 + 리셋 버튼 프론트 추가 (2026-08-06)**: 사용자가 브라우저로 직접 데모를 돌리다 "가상 유저 투입했는데 재고가 안 줄어요", "큐 적체도 그대로 0", "리셋 버튼이 안 보여요"를 리포트 — 조사 결과 서로 다른 원인 2개가 겹쳐 있었다.
  - **버그 A(가장 심각) — 테스트가 실서버 BullMQ 스케줄러를 통째로 지움**: `admission.processor.spec.ts`·`sweep.processor.spec.ts`·`reconcile.processor.spec.ts`의 `afterAll`이 `queue.obliterate({ force: true })`를 호출했는데, 테스트와 실행 중인 `pnpm start:dev`가 **같은 Redis·같은 큐 이름을 공유**해서, 이 세션 동안 `jest`를 돌릴 때마다 **실서버가 등록해둔 반복(repeat) job 스케줄러까지 함께 삭제**됐다. `docker exec sunchak-redis redis-cli`로 확인해보니 `queue:event:*` Sorted Set엔 201명이 쌓여 있는데 `bull:admission:repeat:*` 키가 아예 없어 admission 잡이 한 번도 안 돌고 있었다. **반복 job 스케줄러는 같은 큐+옵션을 등록하는 모든 프로세스가 공유하는 멱등 자원이라 테스트에서 지울 이유가 없다** — 3개 spec 파일에서 `obliterate()` 호출과 그 때문에만 필요했던 `queue`/`Queue`/`getQueueToken` import·변수를 제거(`moduleRef.close()`만으로 정리 충분). 서버 재기동으로 스케줄러 재등록 → 막혀 있던 201명이 5초 내 정상 소진되는 것 확인.
  - **버그 B — 가상 유저가 결제를 안 해서 영원히 HELD**: ADR 0018(모의결제)에서 confirm 트리거를 "HELD 생성 시점"에서 "결제 성공 시점"으로 옮겼는데, `DemoService.simulateBookingAttempt()`는 그때 안 고쳐져서 여전히 `reservations.create()`만 부르고 끝났다 — 결제를 아무도 안 하니 confirm job이 영원히 안 들어가 HELD에서 멈춤(5분 TTL 스윕 전까지). `ReservationsModule`이 `PaymentsService`를 추가로 `exports`하도록 하고, `DemoService`에 주입해 `simulateBookingAttempt()`가 예매 성공 뒤 `payments.pay(reservation.id, userId, randomUUID())`를 호출하도록 수정(실사용자와 동일한 결제 경로, 특수 분기 없음). `demo.service.spec.ts` 목·단언 갱신.
  - **리셋 버튼**: 백엔드 `POST /demo/reset`은 ADR 0016 때부터 있었는데 누를 UI가 없었다 — `demo-dashboard.tsx`에 "실시간 판매 현황" 헤딩 옆에 "데이터 리셋" 버튼 추가(`useMutation`, 성공/실패 문구 표시). 신규 테스트 1건.
  - **검증**: API는 obliterate 제거로 테스트 수 변화 없음(73개 그린, 위험한 정리 로직만 삭제). web은 리셋 테스트 추가로 **14→15개 그린**(`tsc --noEmit`·`eslint` 클린). 실서버 curl로 게이트 통과 후 `POST /demo/reset` 호출 → 재고가 정확히 100/100으로 원복되는 것 확인.
  - **교훈**: 반복 job(`repeat`) 스케줄러처럼 **여러 프로세스가 같은 이름으로 공유하는 Redis 자원은, 테스트 정리 코드에서 "전체 삭제" 계열 API(`obliterate`)를 함부로 쓰면 안 된다** — `moduleRef.close()`(연결만 끊기)로 충분한 경우가 많다.
- **✅ 리셋↔대기열 경합 수정 + "재고소진 실패" 지표 추가 (2026-08-06)**: 위 버그 2건을 고친 뒤 사용자가 직접 재현한 세 번째 시나리오 — "대기열 진입(순번 0) → 가상 유저 200명 투입 → 즉시 98개+2개 예매 → 멈춘 것처럼 보임(결제 실패도 안 늘어남) → 리셋 → 그런데 리셋 후에도 재고가 또 깎임".
  - **원인 분석(사용자 질문 두 가지에 대한 답)**: ① "멈춘 게 맞나?" → 아니다. 200명은 입장 허가(20명/2초)+랜덤 지연(0.5~10초) 때문에 처리에 최대 30초가 걸리는 게 정상이고, 재고가 소진된 뒤 나머지 시도는 [`demo.service.ts`](apps/api/src/demo/demo.service.ts)의 `ConflictException` catch에서 조용히 삼켜져(재고소진은 정상 종료 시나리오) 어떤 스탯에도 안 잡혔을 뿐 실제로 멈춘 게 아니다. **결제 실패(`failedCount`)는 결제 단계까지 도달한 뒤 20% 확률로만 발생**하는데, 재고소진으로 막힌 시도는 결제 단계 자체에 도달하지 못해 별개 지표라 안 늘어난 것도 정상. ② "리셋 시 대기열도 초기화해야 하지 않나?" → 맞다, 버그였다. `resetDemoEvent()`가 재고·예매·유저만 지우고 Redis 대기열(`queue:event:{id}` Sorted Set)은 안 건드려서, 리셋 전에 대기 중이던 가상 유저들이 리셋 후에도 계속 입장 허가를받아 방금 원복한 재고를 또 깎았다.
  - **수정**: `QueueService.purge(eventId)`(ZSet 삭제 + `queues:active`에서 제거) 신규 추가 → `resetDemoEvent()`가 재고 리셋과 함께 호출. `reservations.service.ts`의 `createHeld()` 재고소진 분기에 `soldout:event:{id}` Redis 카운터 추가, `DemoStats.soldOutCount`로 노출(결제 실패와 구분되는 별도 타일).
  - **⚠️ 알려진 한계(의도적으로 남긴 범위, 사용자 확인 후 결정)**: 이미 입장 허가를 받아 `admitted:event:{id}:{userId}` TTL 키를 든 채 랜덤 지연 중인 사람은 대기열 ZSet에 없어 `purge()`가 못 막는다 — 그 창(입장 허가창, 기본 8초)이 지나야 자연히 막힌다. **실서버로 재현 검증**: 30명 투입 1초 후 즉시 리셋 → 대기열은 그 자리에서 0으로 비워졌지만, 이미 허가받은 소수가 이후 수 초간 재고를 100→97까지 깎는 것 확인(200명 중 대다수가 새던 예전 버그 대비 훨씬 좁은 창으로 축소). 그 창(약 10~15초)이 지난 뒤엔 리셋이 완전히 깨끗하게 100으로 복구되는 것도 확인 — "리셋 직후 몇 초는 잔여 활동이 있을 수 있다"를 감수하기로 함(완전 차단은 세대 기반 무효화가 필요해 범위 초과로 보류).
  - **테스트**: `queue.service.spec.ts`(+1, purge) · `demo.service.spec.ts`(+1, 리셋 시 대기열 비움 확인 / stats 테스트에 soldOutCount 포함) · `reservations.service.spec.ts`(재고부족 테스트에 soldout 카운터 단언 추가). **API 73→75 그린.** `demo-dashboard.tsx`에 "재고소진 실패" 타일 추가, `demo-dashboard.test.tsx` 갱신. **web 15개 유지(기존 테스트 보강).**
- **✅ 이벤트 목록 별도 페이지 분리 + 결제 TTL 30초 + `demo` 도메인 개념 정리 (2026-08-06)**: 세 가지 요청을 한 번에 처리.
  - **`demo` 도메인 질문**: "`demo`가 테스트/프로덕션 경계가 아니라 가상유저 플로우 이름이면 무방하다"는 사용자 확인에 대해, `app.module.ts`의 전역 `DemoGateGuard`가 배포 서버 자체에서 상시 동작한다는 코드 근거로 **맞다**고 답변 — 이 프로젝트엔 "데모와 분리된 진짜 프로덕션"이 따로 없고 배포된 사이트 자체가 데모라, `demo`는 환경 분기가 아니라 기능 도메인 이름. 리네이밍은 안 함(비용 대비 이득 적음).
  - **결제 TTL 5분→30초**: `reservations.service.ts`의 `HELD_TTL_MS`를 `30 * 1000`으로 변경. **sweep 주기도 30초→5초로 같이 좁힘**(`SWEEP_INTERVAL_MS`) — TTL과 sweep 주기가 같으면 "30초 후 반환"이 최악의 경우 최대 60초까지 늘어져 체감이 어긋나기 때문. 실서버 e2e로 HELD 생성 후 결제 없이 방치 → heldUntil(30초 뒤) 근처에서 sweep이 회수(DB EXPIRED + Redis 재고 원복)되는 것 타임스탬프로 확인(생성 01:31:22, 회수 확인 01:31:56).
  - **이벤트 목록을 별도 페이지로 분리 + 판매중(ON_SALE)만 진입 가능**: 신규 `app/events/page.tsx`(목록) + `app/events/[id]/page.tsx`(상세, `status!=='ON_SALE'`이면 예매 화면 대신 안내문). `event-list.tsx`는 ON_SALE 카드만 `next/link`로 연결. `booking-form.tsx`는 더 이상 `/events`를 스스로 조회하지 않고 호출부가 검증한 `eventId`/`eventTitle`을 props로 받음. `demo-dashboard.tsx`는 인라인 `EventList`/`BookingForm`을 제거하고 "이벤트 목록 보기 →" 링크로 대체(대시보드는 순수 관측/운영 패널이 됨).
  - **⚠️ 회귀 발견·수정**: `/events/[id]`가 독립 라우트가 되며 로그인 전(게이트만 통과)에도 도달 가능해져서, `handleJoinQueue`가 401 응답을 확인 안 하는 기존 결함이 실제로 드러날 뻔했다(로그인 안 된 방문자가 "대기열 입장"을 눌러도 화면은 성공한 것처럼 보임) — `res.ok` 체크 추가로 고침.
  - **테스트**: `event-list.test.tsx`(+1) · 신규 `events/[id]/page.test.tsx`(3) · `booking-form.test.tsx`(props 방식 전환 +1, 401 회귀) · `demo-dashboard.test.tsx`(EventList/BookingForm mock 제거, 링크 테스트로 교체) · `page.test.tsx`(mock 단순화). **web 15→21 그린.** API는 상수만 바꾼 것이라 **75개 유지**(sweep/reconcile 테스트는 heldUntil을 직접 세팅해 상수에 안 의존).
- **✅ 예매·판매현황 화면 재통합 + "포기(abandoned)" 지표 신설 (2026-08-06)**: 사용자가 실제로 `/events/*`에 들어가보니 대기열 입장 UI만 있고 판매현황·가상유저투입이 안 보여 "테스트가 안 된다"고 지적, 동시에 "200명 투입했는데 재고소진(121)+결제성공(10)이 200과 안 맞는다"는 두 번째 이슈도 제기.
  - **화면 재구성**: 방문자가 자기 예매를 눌러보면서 그 결과(재고·큐 적체 등)를 동시에 지켜봐야 테스트가 의미 있다는 피드백을 받아, 직전에 분리했던 예매(BookingForm)와 판매현황(DemoDashboard)을 **다시 한 페이지로 합침** — 단 위치는 바꿔서 `/events/[id]`(이벤트 상세)에 둘 다 렌더(이벤트가 하나뿐인 데모라 stats도 사실상 그 이벤트 전용이라 자연스러움). 루트 `/`는 게이트+로그인 통과 후 화면을 직접 그리지 않고 `router.replace('/events')`로 넘겨 목록 렌더링 코드가 두 곳에 중복되지 않게 함. `demo-dashboard.tsx`의 "이벤트 목록 보기" 링크는 제거(이벤트 상세 페이지에 이미 "← 이벤트 목록으로" 백링크가 있어 중복).
  - **숫자 불일치 원인 3가지**: ① **입장 허가 후 확률적 포기(기본 20%)가 어떤 카운터에도 안 잡힘** — 예매 시도 자체를 안 해서 soldOut에도 안 걸림. ② **입장 허가창(8초)보다 랜덤 지연(최대 10초)이 길 수 있어, 허가가 자연 만료돼 조용히 실패하는 경우도 안 잡힘**(기존 코드가 "조용히 넘어간다"고만 하고 집계는 안 함). ③ 200명은 처리에 최대 30초 걸리는데 스냅샷은 그 중간 시점이었고, 모든 카운터가 "이번 라운드"가 아니라 **리셋 이후 누적치**라 혼란을 더함.
  - **수정**: `soldout:event:{id}`와 같은 방식으로 `abandoned:event:{id}` Redis 카운터 신설 — 확률적 포기(`demo.service.ts` 269행 부근)와 허가창 만료(`ForbiddenException` catch, soldout과 결과가 같아 같은 카운터로 묶음) 둘 다 여기 누적. `DemoStats.abandonedCount`로 노출, `resetDemoEvent()`가 0으로 리셋, 프론트에 "포기(미시도)" 타일 추가.
  - **실서버로 등식 검증**: 리셋 후 40명 투입 → 전수 처리 대기 후 `paidCount(27)+failedCount(1)+soldOutCount(0)+abandonedCount(12) = 40` 정확히 일치 확인.
  - **테스트**: `demo.service.spec.ts`(포기·허가창만료 테스트 2건에 카운터 단언 추가, stats 테스트에 abandonedCount 포함). **API 75개 유지**(신규 `it` 없이 기존 테스트 보강). `demo-dashboard.test.tsx`(SSE 스냅샷 테스트에 abandonedCount 포함) · `events/[id]/page.test.tsx`(QueryClientProvider 래핑 추가, DemoDashboard 공존 확인) · `page.test.tsx`(useRouter mock으로 `/events` 리다이렉트 검증으로 교체, "이벤트 목록 보기" 링크 테스트는 그 UI가 사라져 제거). **web 21→20 그린.**
  - **실서버 e2e(Playwright)**: 게이트→로그인→루트 접속 시 `/events`로 자동 리다이렉트, 이벤트 클릭 시 `/events/[id]`에서 "내 예매"와 "실시간 판매 현황"이 한 화면에 공존하는 것 스크린샷으로 확인, 콘솔 에러 0.
- **✅ "입장 대기중" 지표 추가 (2026-08-06)**: 사용자가 "대기열 진입 전 가상 유저 수도 집계할 수 있나요"라고 질문 — "요청했지만 아직 대기열에 join도 안 된 수(투입 배치 진행률)" vs "이미 대기열엔 들어갔지만 아직 허가를 못 받은 수" 두 해석이 갈려 사용자에게 확인 후 **후자**로 확정.
  - **구현**: `QueueService.size(eventId)`(입장 대기열 Sorted Set의 `ZCARD`) 신규. `DemoStats.admissionQueueCount`로 노출(`queueBacklog`와 이름이 비슷하지만 완전히 다른 큐 — 저건 BullMQ confirm 큐, 이건 Redis ZSet 입장 대기열). 리셋 시 `QueueService.purge()`가 이미 이 ZSet을 비우므로 별도 리셋 로직 불필요. 프론트 "입장 대기중" 타일 추가(재고 잔량 다음, HELD 앞 — 파이프라인 순서를 따름).
  - **부수 질문 대응**: 구현 직전 사용자가 "재고가 있는데도 포기가 뜨는 게 이상하다"고 질문 — abandonedCount는 **재고와 무관**하게 ① 확률적 포기(20%, 예매 시도 자체를 안 함) ② 입장 허가창(8초) 초과로 인한 자연 만료(랜덤 지연이 최대 10초라 창보다 길 수 있음) 두 경로로만 증가한다는 걸 코드 위치(라인 275, 299)로 설명 — 재고 소진(soldOutCount)과는 원인이 다른 별개 지표임을 확인.
  - **테스트**: `queue.service.spec.ts`(+1, `size`) · `demo.service.spec.ts`(stats 테스트에 `admissionQueueCount` 포함, `QueueService.join()`으로 대기 인원 시뮬레이션). **API 75→76 그린.** `demo-dashboard.test.tsx`(SSE 스냅샷에 admissionQueueCount 포함). **web 20개 유지**(기존 테스트 보강).
  - **실서버 검증**: 리셋 후 40명 투입 1초 후 스냅샷 → `admissionQueueCount:20, abandonedCount:4` — 40명 중 첫 배치 20명만 허가 처리되고 나머지 20명이 대기 중, 허가받은 20명 중 정확히 20%(4명)가 포기한 것까지 실시간으로 확인.

## 🔨 진행 중 / 막힌 것
- (막힌 것 없음.)
- 장시간 테스트 시 JWT(1h) 만료 주의 → 재로그인으로 토큰 갱신.

## ▶️ 다음 할 일 (이 순서로)
1. ✅ ~~W1~~ / ✅ ~~W2 + ADR 0014~~ / ✅ ~~W3 전체(설계+2.2~2.5) + ADR 0015~~ / ✅ ~~W4 데이터 리셋+seed~~ / ✅ ~~W4 진입 게이트~~ / ✅ ~~Google SSO~~ / ✅ ~~W4 서버측 부하 시뮬레이션(축 B-1)~~ / ✅ ~~W4 실시간 stats 대시보드(축 B-2)~~ / ✅ ~~W4 프론트 워크스페이스+쿠키 인증 전환~~ / ✅ ~~W4 프론트 실제 화면(게이트→로그인→대시보드)~~ / ✅ ~~Vitest+RTL 도입~~ / ✅ ~~"내 예매"(실제 티케팅) 기능~~ / ✅ ~~선착순 입장 대기열(ADR 0017)~~ / ✅ ~~모의 결제(ADR 0018)~~ / ✅ ~~이벤트 목록/상세 + 판매 현황 통합~~ — **PRD 갭 전부 처리 완료.**
2. **"배포"는 사실 6개 조각 — `01_기술_로드맵.md` Week 4 기준으로 하나도 안 된 상태 (2026-08-06 점검)**. 순서대로:
   1. **Dockerize** — 멀티스테이지 빌드(`apps/api`, `apps/web`). 지금 리포에 `Dockerfile`이 하나도 없음.
   2. **CI/CD(GitHub Actions)** — lint/test → 이미지 빌드 → GHCR push → VM pull&재기동. `.github/workflows` 없음.
   3. **VM 배포 + Nginx 리버스 프록시** — Neon은 이미 있음(ADR 0010). VM은 미착수.
      - **도메인 정렬 검토**: ① 서브도메인 공유(`app.`/`api.` + 쿠키 `Domain=.도메인`)로 `SameSite=Lax` 유지, ② 리버스 프록시로 완전 동일 오리진화(`/api/*` 프록시). 실제 배포처(도메인 보유 여부) 확정되면 둘 중 선택.
      - 배포 시 `GOOGLE_CALLBACK_URL`·`WEB_APP_URL`을 실제 도메인으로, Google Cloud Console의 승인된 리디렉션 URI도 함께 갱신 필요. 다른 도메인이면 쿠키 `SameSite=None`+`Secure`(HTTPS) 강제 — `common/auth-cookie.ts`의 `NODE_ENV` 분기 확인.
   4. **관측(Prometheus+Grafana)** — 요청률/p95/에러율/큐 적체 대시보드. 미착수.
   5. **최종 k6 부하 리포트** — `apps/api/test/load/`엔 W2 락 비교용 스크립트만 있음(그건 §8 "before/after" 문서로 이미 남김, `docs/perf/`). 전체 파이프라인(HELD+큐+SSE) 완성 후의 최종 부하 리포트는 별도로 아직 없음.
   6. **README + 회고(트러블슈팅 기록)** — 미작성.
   7. **(필수) ADR·설계 문서 최신화** — `docs/decisions/` 전체를 실제 구현과 대조해 설계 의도와 다르게 구현된 부분이 있는지 체크. 다르면 문서를 고치는 게 아니라 해당 ADR에 `Superseded`로 표시하고 실제와 다른 이유를 남긴다(§0 "대체된 결정은 지우지 말고 Superseded로 표시" 원칙).
   - (여유 있으면 스트레치, 필수 아님) 분산 락(Redlock)·read replica·Terraform·K8s.
3. (선택) `simulateLoad()`가 쿨다운을 데모 이벤트 확인보다 먼저 거는 순서 정리(위 축 B-1/B-2 "발견(보류)" 참고).
4. (선택, 프로젝트 완성 후) **npm 패키지 보안 검토 자동화 도입** — 비용 0원. GitHub Dependabot 활성화(리포 Settings) + CI(GitHub Actions)에 `pnpm audit` 스텝 추가 + Socket.dev 무료 GitHub App 연결(행위 기반 탐지, PR마다 자동 실행). **커버 범위가 npq보다 넓어서 선택**: npq는 설치 순간 1회 스냅샷만 보는 반면, 이 조합은 이미 설치된 의존성 전체를 생애주기 내내 계속 재검사함(설치 후 새로 등록되는 CVE까지 커버). 2026-08-06 대화에서 조사·확정.

## 🖥️ 이 기기(현재) 로컬 환경 — 재세팅 시 주의
- **Node 버전**: 활성 `node`가 v22.12.0이면 pnpm(v22.13+ 요구)이 거부한다. **nvm의 v22.23.1 사용**: 명령 앞에 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"` 붙이거나 `nvm use v22.23.1`.
  - **⚠️ 2026-08-06까지는 `nvm` 명령 자체가 이 기기에서 안 됐다**(사용자가 자기 터미널에서 `zsh: command not found: nvm` 리포트) — `~/.nvm/nvm.sh`(node 버전 관리 스크립트)는 있었지만 `~/.zshrc`가 그걸 로드(source)하는 코드가 없었던 것. `~/.zshrc`의 `# NVM` 주석 아래에 `NVM_DIR` export + `nvm.sh` source 3줄을 추가해 해결 — **사용자의 새 대화형 터미널에서는 이제 `nvm` 명령이 정상 동작**한다. 단, 이 코드 에이전트(Claude Code) 세션의 Bash 도구는 비대화형이라 `.zshrc`를 안 읽으므로, 에이전트 안에서는 여전히 위 `export PATH=...` 방식을 써야 한다(사람이 직접 여는 터미널과는 별개 상황).
- **`.env`는 gitignore라 기기마다 새로 만든다**(이 기기엔 없어서 재생성함). 로컬 W2/W3용 값: `DATABASE_URL=postgresql://sunchak:sunchak@localhost:5432/sunchak?schema=public`, `REDIS_URL=redis://localhost:6379`, `JWT_SECRET`(로컬 임의값), `PORT=3001`. (docker-compose 계정과 일치.)
- **⚠️ Google SSO는 이 기기의 Google Cloud Console에서 발급한 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`이 `.env`에 있어야 실제 로그인이 된다** — 미설정이어도 서버는 정상 기동하지만 `/auth/google` 시도 시 Google이 거부한다. **다른 기기에서 쓰려면**: 같은 Google Cloud 프로젝트의 OAuth 클라이언트에 그 기기의 콜백 URL(`http://localhost:3001/auth/google/callback`은 보통 기기 무관하게 동일)이 승인된 리디렉션 URI로 등록돼 있는지 확인 + Infisical에 값 동기화(ADR 0011, 아직 안 했으면 이 세션에서 수동으로 넣어야 함).
- **인프라 기동**: `cd infra && docker compose up -d --wait postgres redis`.
- **마이그레이션**: `migrate dev`는 대화형이라 비대화형(에이전트) 환경에서 막힌다. 우회(더 간단, 2026-08-01 확인) = `prisma migrate dev --name <이름> --create-only`(SQL만 생성, 적용 안 함) → `prisma migrate deploy` → `prisma generate`. (사람이 직접 터미널에서 하면 `migrate dev`가 정상.)
- **seed 스크립트 실행**: `prisma db seed`가 내부적으로 `ts-node`를 PATH에서 찾는데, `./node_modules/.bin/prisma`처럼 바이너리를 직접 호출하면 PATH에 `node_modules/.bin`이 없어 `ENOENT` 에러가 난다. `export PATH="$(pwd)/node_modules/.bin:$PATH"`를 먼저 붙이거나 `pnpm exec prisma db seed` 사용.
- **이 기기 `.env`에 `DEMO_GATE_PASSWORD="sunchak-demo"` 추가함(2026-08-06)** — 프론트 게이트 화면을 테스트하려면 필요(미설정 시 게이트 자동 비활성화). 값은 비밀이 아니라 원하면 바꿔도 무방.

## 🧪 테스트 실행법
- `cd apps/api && pnpm exec jest`(전체 76개) 또는 `pnpm exec jest reservations`(held+SSE+sweep+reconcile+컨트롤러+결제 통합 26개) · `pnpm exec jest demo`(리셋+게이트+시뮬레이션+stats 23개) · `pnpm exec jest auth`(회원가입/로그인/Google SSO 9개) · `pnpm exec jest queue`(대기열 admission+purge+size 14개, ADR 0017). 사전조건: 로컬 PG·Redis 기동.
- `cd apps/web && pnpm test`(전체 20개, Vitest). ⚠️ 이 세션 bash 환경에 `NODE_ENV=production`이 섞여들면 `React.act is not a function`으로 전부 깨진다(코드 문제 아님) — `NODE_ENV=test pnpm test`로 덮어써서 실행.
- **테스트 후 데모 이벤트가 지워진다**(위 참고) — 브라우저로 다시 보려면 `pnpm exec prisma db seed` + `POST /demo/reset` 필요.
- ⚠️ 실DB를 쓰는 통합 스펙 파일이 여러 개(reservations/sweep/reconcile/demo)라 **`maxWorkers: 1`(package.json jest 설정)로 직렬 실행** — 병렬 실행 시 서로의 `beforeEach` 전체삭제가 충돌한다(2.5에서 발견).
- ⚠️ **`jest`는 로컬 DB의 이벤트·예매·유저를 전부 지운다**(여러 스펙 파일의 `beforeEach`가 격리를 위해 `deleteMany()`함 — 별도 테스트 DB가 아니라 개발 DB를 공유). 테스트 실행 후 브라우저로 데모를 다시 보려면 `pnpm exec prisma db seed` + `POST /demo/reset`으로 재시드해야 한다(2026-08-06 확인).
- ⚠️ **백그라운드로 `pnpm start:dev`를 띄워둔 채 `jest`를 돌리면 안 됨** — 둘 다 같은 Redis의 `confirm` 큐 job을 서로 가져가려고 경쟁해서, SSE 방송(워커=인메모리 `Subject`)을 기다리는 테스트가 타임아웃한다(2026-08-06 e2e 검증 중 발견 — 버그 아니라 프로세스 두 개가 같은 큐를 나눠 먹은 것).
  - **⚠️ `lsof -ti:3001 -sTCP:LISTEN | xargs kill`로는 안 지워질 수 있다**: `pnpm start:dev`는 래퍼 프로세스고, 실제 서버(BullMQ 워커 포함)는 그 자식인 `nest.js start --watch`다. 래퍼(또는 포트 점유자)만 죽이면 이 자식이 **고아 프로세스로 남아 포트 없이도 Redis에 계속 연결된 채** job을 계속 가로챈다(이번 세션에 5개나 쌓였었다 — DB는 맞게 바뀌는데 SSE 이벤트만 안 오는 걸로 원인 진단에 시간이 걸림). **올바른 정리**: `ps aux | grep "nest.js start" | grep -v grep | awk '{print $2}' | xargs -r kill -9` (포트 점유자도 함께: `lsof -ti:3001 | xargs -r kill -9`).
- ⚠️ **`pnpm exec`가 막히면**: bullmq의 선택적 네이티브 빌드(`msgpackr-extract`)가 스킵돼 pnpm의 실행 전 deps 점검이 실패할 수 있다. 우회 = 바이너리 직접 호출 `./node_modules/.bin/jest`, `./node_modules/.bin/tsc --noEmit`. (기능 무해 — JS로 폴백. 원하면 `pnpm approve-builds`로 승인.)
- W2 벤치: 서버(`pnpm start:dev`)+로컬 PG 기동, admin 계정 존재 확인 후 `ADMIN_PASSWORD=... bash apps/api/test/load/bench.sh`.

## 🖥️ 다른 기기에서 이어받는 법 (W2/W3는 로컬 DB!)
1. `git pull`
2. 이 파일 읽기 → "다음 할 일"부터.
3. **의존성 설치는 이제 루트에서 한 번**(2026-08-05 pnpm 워크스페이스 도입): `pnpm install`(루트, `apps/api`+`apps/web` 전부 설치됨). `cd apps/api && pnpm install` 처럼 하위에서 개별 설치하지 않는다.
4. **로컬 PG + Redis 기동**: `cd infra && docker compose up -d --wait postgres redis`.
5. `.env` 확인/생성(위 "이 기기 로컬 환경" 참고, `apps/api/.env`) → `cd apps/api && pnpm exec prisma migrate deploy && pnpm exec prisma generate`.
6. 백엔드: `cd apps/api && pnpm start:dev`(또는 루트에서 `pnpm --filter @sunchak/api start:dev`). 프론트: `pnpm --filter @sunchak/web dev`. 테스트: `cd apps/api && pnpm exec jest`.
7. 더 깊은 맥락: `docs/DEVLOG.md` → `docs/decisions/` → `git log`.
