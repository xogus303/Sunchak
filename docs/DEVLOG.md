# 개발 이력 (DEVLOG)

프로젝트 진행 중 결정·삽질·배운 점을 시간순으로 기록한다. 나중에 포트폴리오 회고/README의 재료가 된다.

---

## 2026-07-10 · 프로젝트 킥오프

- **결정**: 주제를 "선착순 티켓 예매(Sunchak)"로 확정. 이유 — DB 설계·동시성/큐·인증을 도메인이 자연스럽게 요구하는 소재.
- **스택 확정**: Next.js(FE) + NestJS(BE) + PostgreSQL + Redis + BullMQ + SSE. 인프라는 Docker + 클라우드 VM + GitHub Actions.
- **범위**: 실 결제(PG)는 제외, 모의 결제 + 비동기 처리로 대체. 좌석 배치도는 수량 기반으로 단순화.
- **문서**: 기술 로드맵(`01_기술_로드맵.md`), 서비스 기획안(`02_서비스_기획안.md`) 작성 완료.
- **셋업**: `~/Desktop/sunchak` 폴더 구조 생성, git 이력 시작, 로컬 postgres+redis용 docker-compose 작성.
- **다음**: W1 — Prisma 스키마(ERD 구현) + NestJS 프로젝트 스캐폴딩 + JWT 인증.

## 2026-07-10 · 의사결정 기록(ADR) 체계 도입

- **관행 도입**: 모든 중요한 선택은 `docs/decisions/`에 ADR로 남긴다(대안·근거 포함). 학습 최우선 원칙에 따라 "왜 이걸 골랐나"를 항상 기록.
- **초기 기록**: 지금까지의 결정 8건 작성 — NestJS(0001), Prisma(0002), PostgreSQL(0003), Redis(0004), BullMQ(0005), SSE(0006), 모노레포(0007), Next.js(0008).
- **원칙**: 대안이 있으면 비교표로, 없으면 근거만. 대체된 결정은 지우지 않고 `Superseded`로 표시해 사고 흐름을 보존.

## 2026-07-10 · W1 시작 — Prisma 스키마로 ERD 구현

- **셋업**: `apps/api`를 독립 패키지로 생성(ADR 0007 "초기엔 도구 없이 폴더 분리" 방침). `package.json`(prisma 스크립트), `.env`/`.env.example`(DATABASE_URL은 docker-compose 계정과 일치).
- **스키마**: `apps/api/prisma/schema.prisma`에 PRD의 ERD 구현 — User/Event/Inventory/Reservation/Payment + enum 4종(Role, EventStatus, ReservationStatus, PaymentStatus).
- **핵심 설계 결정(→ ADR 0009)**:
  - PK는 `Int autoincrement` — 인덱스 지역성·`EXPLAIN` 학습 우선. 순차 ID 노출 방어는 향후 과제.
  - **재고를 `Inventory`로 분리** — W2에서 재고 행만 잠가 락 경합 범위를 좁히기 위함(이 스키마의 핵심).
  - 상태값은 Postgres enum(DB 레벨 무결성), 금액은 `Int`(원 단위, Float 금지).
  - 조회 패턴 기반 인덱스 + `version`(낙관적 락), `idempotencyKey`(멱등성) 컬럼을 W2/W3용으로 미리 심음.
- **삽질**: 샌드박스에서 `prisma validate` 실행 실패 — 엔진 바이너리 다운로드가 네트워크 정책상 403. 스키마는 수동 리뷰로 검증. **실제 검증/마이그레이션은 로컬에서** `docker compose up -d` 후 `npx prisma migrate dev` 로 수행할 것.
- **다음**: 로컬에서 첫 마이그레이션(`migrate dev`) → NestJS 스캐폴딩 → PrismaModule 연결 → JWT 인증(argon2) + 이벤트 CRUD.

### 배운 점 / 메모
- 스키마 설계는 "지금 동작"이 아니라 "뒤에서 실험할 거리(락·큐·멱등)를 미리 심는" 작업이라는 관점 — 재고 분리/version/멱등키가 전부 W2~W3 학습과 1:1로 대응.
- 돈은 절대 Float 금지. 보조단위 없는 KRW는 정수 원으로.

## 2026-07-10 · W1 — NestJS 뼈대 얹기 (apps/api)

- **상황**: 위 Prisma 스키마 단계가 다른 세션에서 완료돼 있었다. 이 세션에서 이어받아 **기존 스키마는 보존**하고 그 위에 NestJS 레이어만 추가.
- **추가한 것**: `package.json`에 Nest 의존성/스크립트(`build`/`start:dev` 등), `tsconfig.json`·`nest-cli.json`, `src/main.ts`(PORT 3001), `src/app.module.ts`(ConfigModule 전역 + PrismaModule), `src/app.controller.ts`(GET `/health`), `src/prisma/{prisma.module,prisma.service}.ts` — `@Global` PrismaService로 어디서든 주입.
- **검증**: 샌드박스 임시 폴더에서 `npm install` + `nest build` 통과(dist 생성 확인). `prisma generate` 엔진 바이너리 다운로드만 샌드박스 네트워크(403)로 실패 — 로컬 맥에선 정상.
- **회고**: 이전에 `git add -A`가 다른 세션 파일을 엉뚱한 커밋에 혼입시킴 → 이후 커밋은 **경로 명시**.
- **다음(로컬에서)**: `cd apps/api && npm install && npx prisma migrate dev` → `npm run start:dev` 후 `curl localhost:3001/health` 확인 → 인증(JWT, argon2) + 이벤트 CRUD.

## 2026-07-10 · 인프라 결정 — 두 기기 공유 위해 Neon(클라우드 DB) 채택

- **요구**: 회사/집 두 노트북에서 데이터까지 동일하게 공유. 코드·DB구조는 git으로 이미 공유되지만 데이터(행)는 로컬 DB에 갇힘.
- **결정(ADR 0010)**: 개발 DB는 **Neon 서버리스 Postgres**(무료, 유휴 시 0원)에 두고 두 기기가 같은 `DATABASE_URL`로 접속 → 데이터 자동 공유. **Redis는 로컬**(휘발성이라 공유 불필요). 비밀값은 커밋 금지·기기별 주입. 초기 데이터는 시드 스크립트로 재현.
- **비교**: 로컬 Docker만(데이터 공유 X), Supabase(7일 미사용 시 정지), Railway(상시 무료 아님) → Neon 채택.
- **주의**: W2 대량 부하테스트는 무료 한도에 걸리므로 그 구간만 로컬 Postgres로 분리 예정.
- **반영**: `apps/api/.env.example`에 Neon(dev)/로컬(W2) 두 형식 주석, CLAUDE.md §9·PROJECT_INSTRUCTIONS에 "기기 간 재현성" 원칙 추가.
- **다음**: Neon 프로젝트 생성 → 연결 문자열을 `apps/api/.env`에 주입 → `npx prisma migrate dev --name init`.

## 2026-07-14 · 비밀값 관리 — Infisical 채택 + Neon 프로젝트 생성 완료

- **Neon**: `sunchak` 프로젝트 생성 완료(싱가포르 리전, Postgres 18, production 브랜치). 유휴 시 scale-to-zero.
- **결정(ADR 0011)**: 비밀값은 **Infisical**(무료·오픈소스)에 저장, `infisical run -- <명령>`으로 런타임 주입. 평문 `.env`를 기기 간에 나르지 않음.
- **비교**: 로컬 .env 수동공유(유출 위험), Doppler(클로즈드), 1Password(유료) → Infisical 채택.
- **반영**: `.env.example` 상단에 "값은 Infisical, 이 파일은 키 목록" 명시. CLAUDE.md §9·PROJECT_INSTRUCTIONS 갱신.

## 2026-07-14 · 기기 간 세션 싱크 — `STATUS.md` 도입

- **문제**: Claude Code 데스크톱 앱이 기기(회사/집) 간 세션(대화)을 공유하지 않음이 확인됨. 코드는 git으로 공유되지만 "어디까지 했는지"의 맥락이 끊김.
- **결정**: 세션 공유는 포기하고, **`docs/STATUS.md`**(현재 상태·다음 할 일의 항상 최신인 스냅샷 1장)로 싱크. 계속 쌓지 않고 **덮어써서** 유지. 세션 시작 시 먼저 읽고, 끝/커밋 전 최신화.
- **역할 분리**: `STATUS.md`(현재 스냅샷) / `DEVLOG.md`(시간순 이력·삽질) / `decisions/`(결정 근거).
- **반영**: CLAUDE.md §9, PROJECT_INSTRUCTIONS "기기 간 재현성"·"새 세션에서 이어가기" 갱신.
- **다음**: Neon 연결 문자열 확보 → Infisical 가입/프로젝트 생성 → CLI 설치·로그인 → `infisical run -- npx prisma migrate dev --name init`로 첫 마이그레이션.

## 2026-07-14 · 패키지 매니저 pnpm 채택 (ADR 0012)

- **결정**: 모노레포·재현성 위해 **pnpm** + corepack 버전 고정. npm/yarn 대비 빠르고 디스크 절약, 엄격한 의존성.
- **전환**: `apps/api`에서 `corepack use pnpm@latest`로 버전 고정, `package-lock.json` 제거 → `pnpm-lock.yaml` 생성.
- **명령 변경**: `npm install`→`pnpm install`, `npx prisma ...`→`pnpm exec prisma ...`. 마이그레이션은 `infisical run --env=dev -- pnpm exec prisma migrate dev --name init`.
- **비고**: Infisical CLI는 brew의 Command Line Tools 구버전 이슈로 `npm i -g @infisical/cli`(npm 전역)로 설치. `infisical init`으로 apps/api 연결(.infisical.json — 비밀값 없음, 커밋 가능).
- **다음**: pnpm 전환 후 첫 마이그레이션 실행 → 생성된 migration.sql 리뷰.

## 2026-07-14 · W1 — 인증(회원가입/로그인/보호가드) + 이벤트 CRUD

- **첫 마이그레이션 성공**: `infisical run --env=dev -- pnpm exec prisma migrate dev --name init` → Neon에 테이블 5 + enum/인덱스/FK 생성. 서버 기동 + `/health` 200 확인.
- **인증 구현 (→ ADR 0013)**:
  - `POST /auth/signup` — DTO(class-validator) 검증 + argon2 해싱 + 유저 생성, 비번 해시 응답 제외. 전역 ValidationPipe.
  - `POST /auth/login` — `argon2.verify`(재해싱 비교) 후 JWT 발급. 실패는 401 동일 메시지.
  - 보호 가드 — passport-jwt Strategy + `JwtAuthGuard` + `@CurrentUser`. `GET /auth/me`.
- **이벤트 CRUD**: `GET /events`(공개 목록)·`GET /events/:id`(공개 상세, 404)·`POST /events`(관리자만). `RolesGuard`+`@Roles(Role.ADMIN)`, 두 가드 순서(JWT→Roles), Prisma 중첩 생성으로 Event+Inventory 동시 생성, `ParseIntPipe`.
- **삽질/메모**:
  - pnpm11은 build script 기본 차단 → `pnpm-workspace.yaml`의 `allowBuilds`로 prisma·argon2 허용(package.json `pnpm` 필드는 pnpm11에서 무시됨).
  - `@nestjs/jwt`의 `expiresIn`이 ms의 엄격한 타입 요구 → `config.get`(제네릭 없이)로 회피.
  - JWT payload는 암호화가 아니라 인코딩(누구나 디코딩) → 민감정보 금지. role 변경 시 **재로그인** 필요(토큰에 role이 스냅샷됨).
- **학습 규칙 강화**: "코드 자체(각 줄·문법)도 설명" 규칙을 CLAUDE.md/지침에 추가.
- **다음(W1 마무리 → W2)**: auth/events 단위 테스트(Jest) → 동시성 실험(순진한 구현 → 초과판매 재현 → 락 3종+Redis) + k6.

## 2026-07-14 · W1 마무리 — Jest 단위 테스트 셋업 + auth/events 테스트

- **테스트 대상 선정 원칙(학습)**: "분기(`if`/`throw`) 수 ≈ 테스트 수". 우리가 쓴 판단 로직만 테스트하고, DB(Prisma)·argon2·JWT 같은 남의 코드는 mock으로 잘라낸다.
- **작성한 테스트(8개, 전부 통과)**:
  - `auth.service.spec.ts` — login(없는 이메일 401 / 비번 틀림 401 / 성공 시 accessToken+payload), signup(중복 409 / 응답에 password 미포함).
  - `events.service.spec.ts` — findOne(없으면 404 / 있으면 반환), create(재고 `remainingQty === totalQty` 초기화 검증, `expect.objectContaining`으로 관심 필드만 좁게).
- **mock 두 방식 정리(학습)**: 코드가 의존성을 "어떻게 손에 넣느냐"가 방식을 결정. 생성자 주입 → NestJS DI에 `useValue`로 교체(인스턴스 교체), 직접 `import` → `jest.mock`으로 모듈 로더 가로채기(모듈 교체). Jest가 sandbox의 모듈 로더를 소유하기에 `jest.mock`이 가능(hoisting으로 import보다 먼저 등록).
- **삽질 3종**:
  1. `pnpm install`이 Node v22.13+ 요구인데 v22.12.0 → nvm으로 v22.23.1 설치, `nvm alias default`, 루트에 `.nvmrc`(22.23.1) 추가해 두 기기 고정.
  2. `pnpm test`가 테스트 전 의존성 검사에서 실패 — `pnpm-workspace.yaml`의 `unrs-resolver`가 placeholder 문자열이라 boolean 요구를 위반. `false`로 명시(네이티브 가속기, 테스트 불필요).
  3. `@nestjs/testing` 미설치로 `Test.createTestingModule` import 실패 → devDep 추가.
- **추가 설치**: `jest`·`ts-jest`·`@types/jest`·`@nestjs/testing`(devDep), package.json에 jest 설정(`rootDir: src`, `testRegex: *.spec.ts`, `transform: ts-jest`, `testEnvironment: node`) + `test`/`test:watch`/`test:cov` 스크립트.
- **다음(W2)**: 동시성 실험 — 순진한 예매 구현 → 초과판매(oversell) 재현 → 락 3종 + Redis 비교 + k6 부하테스트.

## 2026-07-16 · W2 시작 — 순진한 예매 구현 + 초과판매(oversell) 재현

- **로컬 실험 환경 분리(§9)**: W2 부하는 Neon 무료 한도를 깎으므로 로컬 Postgres로 분리. `infra/docker-compose.yml`의 PG(계정 `sunchak/sunchak`, :5432) 기동 → `apps/api/.env`의 `DATABASE_URL`만 로컬로 교체(기존 Neon URL은 주석 보존) → `prisma migrate deploy`로 스키마 반영. 서버는 infisical 없이 `pnpm start:dev`(로컬 .env 자동 로드).
- **순진한 예매 API**: `reservations` 모듈 신규 — `POST /events/:eventId/reservations`(JWT 필요). 서비스 로직은 일부러 방어 없이 ①재고 읽기 → ②`remainingQty >= quantity` 확인 → ③`remainingQty = 읽은값 - quantity`로 **절대값 덮어쓰기** → ④예매 기록(status 기본 HELD). 단일 요청 검증: 재고 5→4 정상 차감 확인.
- **초과판매 재현**: 재고 1개 이벤트에 동시 요청 30개 발사. race window를 결정적으로 벌리려 ②와 ③ 사이에 `await setTimeout(50ms)` 삽입(학습용 확대경, 실코드 아님).
  - **결과**: 30개 전부 HTTP 201, **예매 30건 / 재고 1 → 초과판매 29건.**
  - **핵심 관찰**: 재고가 `-29`가 아니라 **`0`**. ③을 절대값 덮어쓰기로 했기에 30번의 차감이 서로를 덮어써 사라짐(**lost update**) → 카운터가 "정상"처럼 0을 가리켜 오히려 버그가 안 보임. (원자연산 `{decrement:1}`이었다면 `-29`로 티는 났을 것 — 락 비교 때 재활용 예정.)
- **개념 정리(사용자 학습)**: 버그의 근본은 `await`(지연)이 아니라 **①읽기·③쓰기가 원자적이지 않음**(별개의 두 DB 왕복 = "틈"). `setTimeout`은 틈을 *만든* 게 아니라 *넓힌* 것 — 없어도 버그는 존재하며(DB 지연·폭주 트래픽이 틈을 채움) 다만 확률적(flaky)이라 더 위험. 필요조건=내 읽기~쓰기 틈(방), 방아쇠=**다른 요청의 읽기가 그 틈에 입장**. → 락 = 그 방의 문을 잠가 남의 읽기를 못 들어오게 하는 것.
- **다음**: 락 3종(비관/낙관/DB 원자연산) + Redis로 이 버그를 하나씩 막고 before/after 비교(§8). 첫 타자는 비관적 락(`SELECT … FOR UPDATE` + 트랜잭션).

## 2026-07-16 · W2 — 비관적 락(pessimistic lock)으로 초과판매 차단

- **구현**: `create()`를 `prisma.$transaction(async (tx) => …)` + `tx.$queryRaw\`… FOR UPDATE\``로 교체. 재고 행을 잠그고 읽어 커밋 전까지 다른 예매(쓰기)를 대기시킴. ①~④를 전부 `tx`로 묶어 락 안에서 처리. 트랜잭션 옵션 `{maxWait:20000,timeout:20000}`로 직렬 대기 여유 확보.
- **검증(동일 조건: 재고 1 · 동시 30)**: 순진한 버전 30건 성공/29 초과판매 → **비관적 락 1건 성공·29건 409·초과판매 0.** race window 확대용 `setTimeout(50ms)`를 남겨둔 채로도 방어 성공.
- **개념(사용자 학습)**:
  - `FOR UPDATE` = "곧 UPDATE할 행을 지금 잠근다"(배타적 행 락). 평범한 SELECT는 MVCC로 안 막힘.
  - `tx` = 화살표 콜백의 매개변수이자 "이 트랜잭션 전용 Prisma 클라이언트". `tx.*`로 호출해야 락 안에서 실행. `this.prisma.*`로 하면 트랜잭션 밖(락 무의미).
  - MVCC: "읽는 자는 쓰는 자를 막지 않고, 쓰는 자는 읽는 자를 막지 않는다." 서로 막는 건 쓰기 vs 쓰기.
  - **트레이드오프**: 비관적 락은 "같은 행"을 다투는 요청만 직렬화 → 정확하지만 핫 로우에선 처리량↓. (선착순이 정확히 그 상황.) → 낙관적 락/원자연산과 처리량 비교가 다음 과제.
- **다음**: 낙관적 락(`version` 조건부 UPDATE + 재시도) → DB 원자연산 → Redis + k6 부하 비교(§8).

## 2026-07-16 · W2 — 낙관적 락(optimistic lock)으로 초과판매 차단

- **구현**: `create()`를 재시도 루프(상한 5)로 교체. ① 락 없이 `findUnique`로 `version`+재고 읽기 → ② 매진 확인 → ③ `updateMany({ where:{id, version}, data:{ remainingQty: 읽은값-quantity, version:{increment:1} } })` → `count===0`(그 사이 version 변경=충돌)이면 `continue`로 재시도, `count===1`이면 ④ 예매 기록. `update` 대신 `updateMany`를 쓴 이유: 결과 `{count}`로 조건부 성공/실패를 알 수 있고 unique 아닌 where(version 가드) 허용.
- **검증(동일 조건: 재고 1·동시 30)**: **1건 성공·29건 409·초과판매 0** — 비관적 락과 같은 정확성을, 락을 전혀 잡지 않고 달성. 29건은 version 충돌로 1회 재시도 후 재고 0을 읽어 매진 처리(재시도 상한 미도달).
- **개념(사용자 학습)**:
  - version 가드 UPDATE = compare-and-swap. "내가 읽은 version 그대로일 때만" 적용되므로, 그 조건이 참이면 값이 안 바뀐 게 보장 → 절대값 덮어쓰기도 안전.
  - **비관 vs 낙관 = 비용의 위치**: 비관=대기 비용(핫 로우 직렬화), 낙관=재시도 비용(경합 심하면 thrashing). 경합 드물면 낙관 유리, 극심하면 비관 안정적. 선착순은 순간 경합 극심 → k6로 수치 비교 예정.
- **삽질**: 세션이 1시간을 넘겨 JWT(1h) 만료 → 이벤트 생성이 404로 실패. 재로그인으로 토큰 갱신 후 정상. (토큰에 만료가 박혀 있으니 장시간 테스트 땐 재발급 필요.)
- **다음**: DB 원자연산(`remainingQty >= quantity` 조건부 단일 UPDATE `{decrement}`) → Redis → k6 부하로 세 방식 처리량 before/after(§8).

## 2026-07-16 · W2 — DB 원자연산(atomic conditional update)으로 초과판매 차단

- **구현**: `create()`를 단일 문장으로 축소 — `updateMany({ where:{ eventId, remainingQty:{ gte:quantity } }, data:{ remainingQty:{ decrement:quantity } } })`. 앱에서 읽지 않으므로 read-check-write 틈 자체가 없음. `count===0`이면 매진(409). 트랜잭션·version·재시도·재현용 지연 전부 제거(틈이 없어 지연도 무의미). `NotFoundException` 고아 import 정리.
- **검증**: 재고 1·동시 30 → **1건**만 성공, 재고 5·동시 30 → **정확히 5건**만 성공(둘 다 초과판매 0, 최종 재고 0). 지연 없이도 완벽 — DB의 단일 문장 원자성만으로 방어됨을 실증.
- **트레이드오프 메모**: 순수 1문장이라 "재고 부족"과 "이벤트 없음"을 count===0으로 구분 못 함(구분하려면 추가 조회). 학습 단계에선 단순함 우선으로 둘 다 409 처리.
- **락 3종 정리(개념)**: 비관=미리 잠금(대기 비용), 낙관=version CAS+재시도(재시도 비용), 원자연산=단일 조건부 UPDATE(가장 단순, 앱측 틈 없음). 셋 다 초과판매 0. 차이는 **처리량** → k6로 수치화가 남음.
- **다음**: k6 부하테스트로 순진한/비관/낙관/원자연산 처리량·지연 before/after 비교(§8). 이를 위해 4개 전략을 런타임에 선택 가능하게 할지 결정 필요.

## 2026-07-16 · W2 — 4전략 런타임 선택 리팩터(k6 준비) + 순진한 버전 오버셀 재확인

- **결정**: k6로 4방식을 비교하려면 런타임 전환이 필요 → `?strategy=naive|pessimistic|optimistic|atomic` 쿼리파라미터 방식 채택(서버 재시작 없이 전환, 벤치 반복 빠름). 대안(환경변수=재시작 필요, git checkout=수작업)은 반복이 번거로워 탈락.
- **리팩터**: `ReservationsService.create()`를 진입점으로 두고 `switch(strategy)`로 `createNaive/Pessimistic/Optimistic/Atomic` 4개 private 메서드에 분기. 컨트롤러는 `@Query('strategy')`로 받아 전달(생략 시 기본 atomic). `ReservationStrategy` 타입 export. 알 수 없는 값은 `BadRequestException`.
- **벤치마크용 지연 제거**: 재현용 `setTimeout(50ms)`를 전 전략에서 삭제(있으면 처리량 측정이 그 지연에 묶여 왜곡). 초과판매 재현은 이미 앞 단계에서 증명 완료.
- **검증(재고 1·동시 20, 전략별)**: naive **4건 판매(초과판매 3)**, pessimistic/optimistic/atomic 각 **1건**. → **순진한 버전이 인위적 지연 없이도 로컬 PG 실제 동시성만으로 오버셀**함을 재확인(“지연은 창을 넓혔을 뿐, 버그는 원래 존재”를 실증).
- **다음**: k6 설치·스크립트 작성 → 4전략 동일 부하로 RPS·p95·오버셀 여부 계측 → `docs/`에 before/after(§8).

## 2026-07-16 · W2 — k6 부하테스트로 4전략 처리량 계측(§8)

- **셋업**: k6 v2.1.0 설치(brew). 스크립트 2개를 레포에 포함(재현성§9) — `apps/api/test/load/reservations_load.js`(부하), `bench.sh`(전략별 이벤트 생성→k6→오버셀 확인→요약표).
- **프리셋**: VU 30 · 15초 · 재고 20만(매진 방지, 순수 차감 처리속도 측정) · 단일 재고 행에 전 VU 경합 · 로컬 PG.
- **결과(RPS / 성공 / 실패 / 실제차감 / p95)**:
  - naive: 2460 / 36,918 / 0 / **1,498** / 31.5 → **35,420건 lost update**(빠르지만 완전히 틀림)
  - pessimistic: 1206 / 18,120 / 0 / 18,120 / 60.5 → 정확하나 락 대기로 느림
  - optimistic: 885 / 4,783 / **8,503** / 4,783 / 60.2 → 재고 남았는데 **재시도 소진 8,503 실패**(thrashing)
  - atomic: 2030 / 30,470 / 0 / 30,470 / 41.3 → **거의 최고 속도 + 완벽 정확(승자)**
- **결론**: hot row 고경합(=선착순)에선 **atomic > pessimistic > optimistic**. naive는 속도만 빠르고 정확성 상실. 낙관적 락은 단일 hot row 고경합에서 재시도 낭비로 부적합 — 앞서 개념으로 예측한 트레이드오프가 수치로 확인됨. → 문서: `docs/perf/2026-07-16-w2-lock-comparison.md`.
- **다음**: Redis 원자 차감(`DECR`/Lua) 추가 후 동일 프리셋 비교 → DB 원자연산과의 처리량 차이 확인.

## 2026-07-16 · W2 — Redis 인메모리 원자 차감(5번째 전략) + 5전략 k6 비교

- **개념 정리**: Redis는 RAM 기반 key-value 저장소. **단일 스레드라 명령 하나가 원자적**(명령 "사이"엔 다른 요청을 받지만 명령 "도중"엔 안 끼어듦) → `DECRBY`가 그 자체로 lost update가 없다. DB atomic(조건부 단일 UPDATE)과 같은 "읽기+쓰기를 쪼갤 수 없게 묶기"의 다른 구현. 메모리 계층(디스크<RAM<L3~L1 캐시<레지스터)에서 RAM에 사는 게 속도 이점의 근거.
- **구현**: `RedisService`(ioredis 5.11, PrismaService와 같은 `OnModuleInit/Destroy` 생명주기, `@Global` RedisModule) 추가. `createRedis`: `DECRBY stock:event:<id>` 반환값이 **음수면 `INCRBY`로 보상 후 409**, 아니면 `reservation.create`만 DB에 기록. `DECRBY`엔 재고 조건이 없어 0 밑으로 깎이므로 **반환값으로 매진 판정 + 넘친 만큼 되돌리기**가 핵심.
- **스모크(재고 2·3요청)**: 201·201·409, Redis 재고 정확히 0 안착(음수 안 샘), DB 예매행 2건.
- **결과(RPS / 성공 / 실제차감 / p95, VU30·15s·재고20만)**:
  - naive 2338 / 35,091 / **1,441** / 33.6 → lost update 33,650(틀림)
  - pessimistic 1126 / 16,912 / 16,912 / 67.9 ✅
  - optimistic 859 / 4,640 / 4,640 / 61.9 ⚠️(재시도 8,262 실패)
  - atomic 2024 / 30,374 / 30,374 / 41.8 ✅
  - **redis 9354 / 140,329 / 140,329 / 4.4 ✅ — atomic의 4.6배, p95 최저, 완벽 정확**
- **왜 redis가 atomic보다 4.6배?**(핵심 교훈): 둘 다 단일 카운터에서 직렬화되지만 ①**직렬 구간 1건당 비용**이 다름 — Postgres hot row UPDATE엔 행 락·MVCC·WAL이 붙고 Redis `DECRBY`는 RAM 정수 감산뿐. ②경합하는 차감을 DB에서 들어내니 **DB엔 경합 없는 병렬 INSERT만** 남음. 병목은 "DB가 느려서"가 아니라 **단일 재고 행 쓰기의 직렬화**였음.
- **비용(정합성)**: 재고 진짜 값이 Redis에만 있어 DB `inventories`와 어긋남 + Redis 유실 시 재구성 필요. 실서비스는 Redis로 선착순 관문만 통과시키고 DB 반영은 큐로 뒤에서 맞춤(→ BullMQ 복선).
- **삽질**: zsh에서 명령을 변수에 담아 `$R ping` 호출 시 "command not found"(통째로 명령명 취급) → 풀어서 실행. 옛 dev 서버가 ioredis 설치 전 상태로 떠 있어 kill 후 재기동(RedisModule 연결 반영).
- **다음**: 재고 정합성(Redis 관문 + 큐 반영) 설계는 W3~. 최종 예매 전략은 ADR로 확정. 문서: `docs/perf/2026-07-16-w2-lock-comparison.md`.

## 2026-07-18 · W2 마무리 — 개념 재확인 + 최종 예매 전략 ADR 0014 확정

- **개념 딥다이브(사용자 자기설명으로 검증)**: 왜 Redis가 atomic의 4.6배인가를 밑바닥까지 재정리 — ①선착순 재고는 구조적으로 단일 hot 숫자라 병렬화로 못 피함(재고 행을 흩어도 이벤트 재고는 하나) → ②DB든 Redis든 직렬화되지만 **직렬 1건당 비용**이 갈림. DB 비용의 정체: **행 락**(Isolation), **MVCC 새 버전 생성**(읽기 안 막고 쓰기 = 옛 버전 조회), **WAL fsync**(Durability, 물리 디스크 동기 왕복 = 최종 병목). ③Redis는 이 보장들을 (일부) 포기 — 락·MVCC 없음 + fsync를 요청 경로 밖(AOF everysec=초당 1회 비동기)으로 빼서 요청이 디스크를 안 기다림. **"인메모리라 빠르다"만이 아니라 "동기 지속성을 비동기로 미뤄서 빠르다"**가 정확. 대가가 곧 정합성·유실.
- **오해 교정 2건**: (1) "커넥션 오버헤드"는 풀 재사용이라 주범 아님. (2) "재고 20만으로 흩어져도 똑같이 느림"은 틀림 — 행 락이 사라지면 **병렬화**되어 처리량 폭증(계산대 1개 vs 20만 개). DB가 느린 진짜 이유는 건당 비용이 아니라 **hot row 직렬화로 병렬화가 원천 차단**된 것.
- **ADR 0014 작성**: `docs/decisions/0014-reservation-strategy.md` — **Redis 인메모리 관문(`DECRBY`+보상) + DB 비동기 기록** 채택. 5전략 비교표를 "채택하지 않은 이유"로, 위 논리 사슬을 근거(Rationale)로, 대가(정합성·유실·경계검사·중복방지)를 결과(Consequences)로. DB 단독 시 차선은 atomic(폴백). README 인덱스 갱신.
- **다음**: 정합성 설계(W3~) — Redis 관문 + BullMQ 비동기 반영, Redis↔DB 정합성·유실 재구성·멱등(중복 방지). 후속 ADR로 확정.
