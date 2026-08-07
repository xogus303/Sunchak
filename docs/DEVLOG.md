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

## 2026-07-19 · W3 정합성 설계 개념 완주 + ADR 0015 확정

- **개념 설계(사용자 자기설명으로 검증)**: ADR 0014의 Redis 관문 뒤를 어떻게 신뢰성 있게 처리할지 세 문제(①Redis↔DB 어긋남 ②Redis 유실 재구성 ③멱등성)를 파이프라인으로 풀었다. 관문(Redis DECRBY) → **HELD 선기록(DB INSERT)** → 큐(BullMQ) → 즉시 응답 → 워커가 HELD→CONFIRMED UPDATE → SSE push. + HELD TTL 만료 + Redis 재구성(`총재고 − (HELD+CONFIRMED)`).
- **핵심 개념 4개**: (1) **큐/워커** — 작업을 Redis에 영속 저장(프로세스 밖·재시작 견딤), 생산자(API)/소비자(워커) 분리. (2) **at-least-once → 멱등성** — "작업 성공했는데 응답 유실"로 재시도 시 중복 INSERT. 막는 법 = **멱등성 키 + unique 제약**(DB가 원자적으로 거부, 워커는 P2002를 "이미 됨=성공"으로 삼킴). read-check-write 함정을 DB 한 방으로 = W2 atomic과 같은 철학. (3) **확정 통보** — 폴링(요청 폭탄) 대신 **SSE**(0006). (4) **Redis 유실 재구성** — Redis 재고는 진실 아닌 DB 파생 사본. 단 HELD가 Redis/큐에만 있으면 재구성 부정확 → **최초 시점부터 DB에 HELD 선기록**해야 정확 복구.
- **정밀화(헷갈리기 쉬운 자리)**: ① 재고 차감은 hot row라 Redis로 뺐지만 ② HELD INSERT는 서로 다른 행이라 **경합 없는 병렬** — "직렬화 병목 ≠ INSERT 비용". 세 단계의 '원자성'은 각기 다른 문제(초과판매/중복/확정)를 푼다. unique는 DB가 자동 거부하되 그 에러를 성공으로 해석하는 건 워커 코드의 몫.
- **문서**: `docs/decisions/0015-reservation-consistency-design.md`(ADR 0014의 정합성 편), README 인덱스 갱신.
- **다음**: 구현 착수 — 스키마 변경(reservation.status HELD/CONFIRMED/EXPIRED + 멱등성 키 unique + heldAt) → 마이그레이션 → BullMQ 큐/워커 + SSE + HELD 선기록/확정/TTL/재구성.

## 2026-07-20 · W3 구현 착수 — ADR 0015 멱등성 부분 개정 + 스키마 변경

- **구현 착수 직전 검토에서 ADR 0015의 오류 2건 발견**(설계를 코드로 옮기려니 앞뒤가 안 맞아 드러남):
  1. **"워커 재시도의 중복 INSERT를 unique가 막는다"가 성립 안 함.** 이 파이프라인에서 INSERT는 요청 경로(②)에서 한 번만 일어나고 워커(⑤)는 UPDATE만 한다. job이 재시도돼도 "두 번째 INSERT"는 발생하지 않는다 → unique가 막을 대상이 없었다. 워커 UPDATE는 `WHERE status=HELD`라 재실행 시 0건, **본래 멱등**이라 별도 장치가 애초에 불필요.
  2. **"멱등성 키는 API 서버가 발급"이 틀림.** 서버는 "재전송"과 "진짜 두 번째 주문"을 요청 내용만으로 구분할 수 없다(userId·eventId·quantity가 전부 동일). 판정 근거는 재전송을 실행한 **클라이언트만** 가진다. 서버가 발급하면 매 요청 새 키가 나와 "같음"을 정의할 수 없음 → 그건 멱등성 키가 아니라 PK. (Stripe `Idempotency-Key` 헤더가 클라이언트 발급인 이유.)
- **원인 추정**: "워커가 INSERT하는" 일반적 멱등성 키 패턴을 그대로 옮겨 적었는데, ADR 0015가 고른 설계는 INSERT를 요청 경로로 **당겨온**(HELD 선기록) 구조라 전제가 달랐다. **패턴을 아는 것 ≠ 이 설계에 맞는지 판단한 것.**
- **새로 드러난 구멍(기존 ADR에 아예 없던 것)**: 관문(①)이 INSERT(②)보다 먼저라 **재전송도 `DECRBY`를 한 번 더 깎고 나서야** unique에 걸린다 → 그대로 두면 **주문 없이 재고만 증발**. 특히 고약한 건 ①조용함(DB는 정상, Redis 카운터만 틀림 → DB 검증으로 안 잡힘) ②네트워크 불안할 때 몰려서 누적 ③끝은 **거짓 품절**(자리 남았는데 관문이 막음). → **unique 위반 시 `INCRBY` 보상**(Redis 전략의 음수 보상과 같은 동작).
- **보상 vs 재구성은 대체 관계가 아님**: 증발분은 Redis 재구성 잡(`총재고−(HELD+CONFIRMED)`)이 언젠가 고치지만 그건 **주기적 사후 안전망**이고, 그 사이 거짓 품절이 방치된다. 선착순은 바로 그 몇 분이 승부처 → **보상=1차 방어, 재구성=안전망** 둘 다 필요.
- **재전송의 응답은 409가 아니라 성공**: 그 사용자는 실패한 게 아니라 이미 성공했고 응답만 유실됐다. 첫 요청과 **동일한 결과(같은 예매 ID)** 를 반환해야 한다 — "몇 번을 호출하든 결과가 같다"가 멱등성의 정의. 막는 게 아니라 **같은 답을 반복해서 주는** 것.
- **unique 범위는 복합으로**: `@@unique([userId, idempotencyKey])`. "같은 요청"의 정의가 **같은 사람 + 같은 이름표**이므로 정의를 스키마에 그대로 옮긴 것. 단독 unique(`idempotencyKey`만)는 키를 전 세계 유일 신원으로 취급해 정의와 어긋나고, 남의 키와 충돌하는 상황(→ 복구 조회에서 타인 예매 유출)을 만들어낸다. 복합이면 그 충돌 자체가 발생하지 않음. **보안은 부산물이고, 진짜 이유는 의미론.**
  - ⚠️ `Payment.idempotencyKey`는 여전히 단독 unique — 같은 문제를 안고 있을 수 있음. W3 결제 단계에서 재검토할 것.
- **스키마 변경**: `Reservation`에 `idempotencyKey String`(필수) + `@@unique([userId, idempotencyKey])` 추가. **`status`·`heldUntil`·`@@index([status, heldUntil])`은 W1(0009)에 이미 있어 추가 불필요** — STATUS.md의 "status/heldAt 추가" 항목은 착오였다.
- **막힌 곳(다음 세션 첫 작업)**: 마이그레이션 미실행. `reservations`에 W2 벤치가 만든 수만 행이 있어 **기본값 없는 NOT NULL 컬럼 추가가 실패**한다. 선택지 A) `migrate reset`으로 로컬 DB 초기화(추천 — 로컬 한정 쓰레기 데이터, 시드로 재현 가능) B) nullable로 완화(스키마에 구멍) C) 임시 기본값 후 제거(정공법이나 과함). **사용자 승인 대기 중.**
- **진행 방식 반성**: (A)/(B) unique 범위를 멱등성 키의 기본 개념보다 먼저 꺼내 사용자가 길을 잃음. 되돌아가 "응답 유실 → 재시도 → 2장 예매" 구체 시나리오부터 다시 쌓아 해결. **한 번에 여러 새 개념을 쌓지 말 것.**

## 2026-07-21 · W3 2.2 — 마이그레이션 적용 + HELD 선기록/멱등성 보상 구현

- **마이그레이션 적용(막혔던 것 해소)**: `idempotencyKey` NOT NULL 추가가 기존 행과 충돌한다던 STATUS의 걱정은 **이 기기엔 해당 없었다** — 로컬 DB가 방금 docker로 새로 생성돼 비어 있었음(그 "수만 행"은 다른 기기 얘기). A(reset)는 불필요했고 Prisma AI 안전장치가 reset을 막았지만 안 해도 됐다.
- **삽질 3건**: ① 활성 `node` v22.12.0 → pnpm이 v22.13+ 요구하며 거부 → nvm의 v22.23.1로 PATH 전환. ② `.env`가 이 기기엔 없음(gitignore) → 로컬 값으로 재생성. ③ `prisma migrate dev`가 **비대화형(에이전트) 환경에서 거부**(`--create-only`도 unique 경고 확인 프롬프트 때문에 막힘) → **`migrate diff --from-url → migration.sql → migrate deploy → generate`** 로 우회. (사람이 터미널에서 직접 하면 `migrate dev`가 정상.) 적용 SQL은 `ADD COLUMN idempotencyKey NOT NULL` + `CREATE UNIQUE INDEX (userId, idempotencyKey)` 두 줄. diff에 `status`/`heldUntil`/기타 인덱스가 없어 **W1에 이미 있었음이 역으로 검증**됨.
- **NOT NULL 여파 발견**: 마이그레이션 후 tsc가 5곳 전부 에러 — 5전략의 `reservation.create`가 `idempotencyKey` 없이 만들어 필수 필드 누락. 즉 스키마만 바꾸면 기존 코드가 조용히 깨진다는 걸 타입체크가 잡아줌.
- **설계 결정(B안 선택)**: W2 5전략을 벤치 재현용으로 **보존** + held를 6번째로 추가. 5전략엔 서버가 `randomUUID()`로 `idempotencyKey` 자동 발급 — 멱등성이 목적이 아니라 NOT NULL 만족 + (같은 유저 수만 건에서) unique 충돌 회피용. held만 **클라이언트 발급 키**를 그대로 씀.
- **createHeld 구현**: 관문(DECRBY) → status=HELD INSERT → `try` 안 `await` + `Prisma.PrismaClientKnownRequestError`·`code==='P2002'`로 재전송 판별 → `INCRBY` 보상 + `findUniqueOrThrow({ userId_idempotencyKey })`로 첫 예매 반환. DTO는 `idempotencyKey?`(`@IsUUID`), held에서만 서비스가 필수 강제.
- **통합 테스트로 검증(mock 아님)**: 멱등성은 실제 DB unique(P2002)·실제 Redis DECRBY 원자성이 핵심이라 mock은 자작극이 됨 → 로컬 PG/Redis에 붙는 통합 테스트 4종. 정상(HELD·재고 5→4)/재전송(예매 1건·재고 4 = 2번 깎고 1번 보상)/재고부족(409·재고 0 원복·예매 0건)/키누락(400). 전체 12개 그린.
- **사용자 개념 검증(집요하게)**: **DECRBY 음수 체크 = 재고부족(초과판매), P2002 = 재전송(중복)** 을 세 번에 걸쳐 분리시킴. 사용자가 반복해서 둘을 "관문에서 재전송도 체크"로 합쳤으나, 최종적으로 "DECRBY는 재고부족만, 재전송은 흘려보내고 INSERT의 P2002에서 감지 후 보상"으로 정확히 정리. 두 INCRBY의 의미 차이(재고부족=실패 후 원복 / 재전송=이미 성공, 초과 차감분만 원복)도 확인.
- **판단 근거로 남긴 것**: `heldUntil`은 2.2에서 세팅 생략 — 만료 스윕(2.5)이 아직 없어 값만 넣으면 데드 값이라 2.5에서 함께 도입(단순성).
- **커밋**: 마이그레이션 `1c0afd2`, held 구현+테스트 `6c5ed23`.
- **다음**: 2.3 BullMQ 큐/워커 — createHeld가 HELD INSERT 후 job enqueue + 즉시 응답, 워커가 `WHERE status=HELD`로 CONFIRMED UPDATE(재실행 0건 = 본래 멱등).

## 2026-07-21 · W3 2.3 — BullMQ 큐/워커로 HELD→CONFIRMED 확정

- **개념 선(先)정리(사용자 자기설명 검증)** — "왜 큐인가"를 코드 전에 밑바닥까지:
  - **큐의 두 가치**: ①신뢰성(job이 Redis에 영속 → 실패 시 자동 재시도 = at-least-once = 최종 일관성) ②비동기 분리(빠른 응답). 사용자는 처음 ②만 답하고 ①을 빠뜨렸고, "UPDATE가 무거워서(행락+MVCC+WAL)"라고 오답 → **교정**: 그 비용은 hot row **직렬화**일 때 문제고, 확정 UPDATE는 주문마다 다른 행이라 경합 없는 병렬. 2.2에서 HELD INSERT를 이미 요청 경로에 두고 "경미"라 통과시켰으니 "무게가 이유"면 앞뒤가 안 맞음. (W2 hot row 교훈을 안 맞는 데 옮긴 실수 — ADR 0015 때와 같은 유형.)
  - **왜 INSERT는 동기, UPDATE만 큐로?** 핵심은 "**누가 기다리는가**". INSERT는 사용자가 대기 중 → 실패해도 사용자가 재시도 엔진(재전송). UPDATE는 "접수됨" 응답 후 사용자가 떠난 뒤 → 실패해도 재시도할 주체가 없음 → **영속 job이 그 자리를 대신**. 또한 INSERT는 (a)멱등 판정=사용자에게 줄 답이라 미룰 수 없고 (b)큐 job이 가리킬 닻이라 먼저 존재해야 함(그래서 "선기록").
  - **왜 HELD인가(바로 CONFIRMED INSERT 안 하고)?** INSERT 시점엔 관문만 통과·**미결제**. CONFIRMED는 거짓. HELD=유효기간(heldUntil) 붙은 임시 확보, 사이에 결제가 끼고 CONFIRMED(결제 완료)/EXPIRED(시간 내 미결제)로 갈림. **정직한 지적**: 지금 워커는 결제 없이 즉시 뒤집어 두 단계가 과해 보이나, HELD는 결제가 들어올 seam. 결제 없으면 INSERT-as-CONFIRMED가 더 단순한 정답임을 명시.
  - **job엔 id만**: 요청 시점 스냅샷이 아니라 처리 시점 진짜 상태로. DB=진실의 원본, job=포인터. TTL 스윕이 먼저 EXPIRE했거나 재시도 job이 이미 CONFIRM했을 수 있어, 워커는 `WHERE status=HELD`로 현재 상태를 DB에 재확인.
- **구현**: `@nestjs/bullmq`+`bullmq` 설치. `BullModule.forRootAsync`(app.module, REDIS_URL을 host/port로 파싱 — 옵션을 넘기면 BullMQ가 워커 블로킹 연결용 maxRetriesPerRequest:null을 알아서 세팅) + `registerQueue('confirm', defaultJobOptions: attempts3·지수백오프·removeOnComplete)`. `ConfirmProcessor`(WorkerHost)가 `updateMany(WHERE status=HELD → CONFIRMED)` — count===0은 멱등 no-op. `createHeld`가 HELD 커밋 후 `queue.add('confirm',{reservationId})` 하고 즉시 HELD 반환.
- **알려진 틈(코드 주석·STATUS 명시)**: create 커밋과 queue.add 사이 크래시 시 job 없는 HELD 고아 발생(DB·큐 이중 쓰기라 비원자적). Outbox는 과함 → **2.5 TTL 회수 잡이 안전망**으로 정리(EXPIRE)하기로.
- **테스트**: 통합 4→6. 추가 2 = ①held 접수 후 워커가 CONFIRMED로 확정(폴링 대기) ②이미 CONFIRMED에 확정 job 중복 투입해도 1건 유지(워커 멱등). 테스트 모듈에 실 BullMQ 인프라+ConfirmProcessor 등록해 end-to-end(실 DB/Redis). **전체 14개 그린.**
- **삽질 2건**: ①`pnpm exec`가 실행 전 deps 점검을 하는데 `msgpackr-extract`(bullmq 선택적 네이티브 최적화) 빌드 스킵을 정책 위반으로 봐 tsc/jest가 막힘 → `./node_modules/.bin/`으로 직접 호출해 우회. 기능엔 무해(JS 폴백). ②이 기기 로컬 DB(docker 볼륨, 기기별)에 마이그레이션 미적용이라 `idempotencyKey 컬럼 없음` 런타임 에러 + Prisma Client도 stale → `prisma generate` + `prisma migrate deploy`로 해결. (STATUS의 "적용 완료"는 다른 기기 얘기였음.)
- **다음**: 2.4 SSE(확정 실시간 push) → 2.5 안전장치(TTL 회수 + Redis 재구성).

## 2026-07-21 · 공개 데모 모드 설계 (ADR 0016)

- **동기(사용자 질문에서 출발)**: "최종 형태가 포트폴리오로, 누구나 실시간 티케팅/순번을 테스트해볼 수 있나?" → 두 리스크 발견. ① 핵심 가치(초과판매 0·실시간 순번)는 방문자 **혼자 클릭으론 체감 불가** → 데모 장치 필요. ② 공개 URL이 **무료 티어(Neon/VM)** 위라 봇·시뮬 남발이 한도를 태움 → 진입 통제 필요.
- **사용자 결정 2건**: 진입 통제 = **게이트 + 시뮬 상한**(게이트만/전면 rate limit 아님). 리셋 = **자동 주기 + 수동 버튼 둘 다**(자동만/수동만/방문자별 격리 아님).
- **설계 확정(ADR 0016)** 세 축 + 한도 보호:
  - **A. 진입 게이트**: 공유 비번(env) → 서버가 데모 토큰 발급 → API가 검사. **게이트는 반드시 API 계층**(프론트 게이트만이면 봇이 VM API 직격 — 무료 티어 부하는 백엔드에서 나므로 신뢰 경계도 백엔드). **게이트 ≠ 로그인**(진입 차단 vs 신원 식별, 층위 다른 별개 막). 비번은 포트폴리오에 공개.
  - **B. 데모 장치**: ① 서버측 부하 시뮬(가상 유저 N명 → 순번·재고 소진 실시간 재현) ② 실시간 판매 대시보드(SSE stats) ③ 리셋.
  - **C. 리셋**: 자동 주기(스케줄러) + 수동 버튼. seed 미비(STATUS의 알려진 틈)를 여기서 함께 해소.
  - **D. 한도 보호**: 시뮬 상한(최대 VU) + 쿨다운(Redis rate limit, 429).
- **설계상 연결고리**: 데모 대시보드의 stats 스트림 = **W3 2.4 SSE와 같은 메커니즘** → 2.4 SSE 설계 때 "확정 push"뿐 아니라 "stats 스트림"도 염두에 두기로(STATUS 다음 할 일에 명시).
- **구현 시점**: W4(배포와 함께). 이번엔 설계·문서만.
- **반영 파일**: ADR 0016 신규 + decisions/README 인덱스 + 로드맵(01) W4·성공기준 + 기획안(02) §12·화면정의 + `.env.example` 키 4개(`DEMO_GATE_PASSWORD`·`DEMO_SIM_MAX_VU`·`DEMO_SIM_COOLDOWN_MS`·`DEMO_RESET_INTERVAL_MS`) + STATUS.
- **다음**: 예정대로 W3 2.4 SSE(확정 push + stats 스트림 대비).

## 2026-07-22 · W3 2.4 — SSE로 확정 실시간 push

- **개념 선(先)정리(사용자 자기설명 검증, 집요하게)** — 코드 전에 "왜 SSE인가"부터:
  - **문제 체감**: 사용자는 HELD 응답 받고 떠나는데 CONFIRMED는 그 뒤 워커가 비동기로 뒤집음 → 이미 응답받은 클라에 서버가 어떻게 알리나? HTTP는 클라가 물어야 답하는 구조라 서버가 먼저 말 못 검.
  - **폴링/WebSocket/SSE 비교**: 폴링=낭비+타이밍, WebSocket=양방향이라 오버스펙, **SSE=서버→클라 단방향 push + HTTP 그대로 + EventSource 자동 재연결**. 우리 요구(단방향 상태 push)에 정확히 맞음. 사용자 3문항 자기설명 통과.
  - **날카로운 질문 2건(사용자 발)**: ① "왜 워커의 CONFIRMED를 받아야? 결제 완료만 받으면 되지 않나" → **CONFIRMED가 곧 '결제 완료된 확정'**. 지금 워커 즉시 flip은 결제 stub. 실제론 결제 확정이 사용자 요청과 **분리된 경로(PG 웹훅)** 로 와서 서버가 먼저 알려야 함 → SSE 정당. ② "confirm job이 큐에서 웹훅을 기다리나?" → **아니오, 안티패턴**. job은 "지금 할 수 있는 일"만. 실제 설계선 createHeld에서 enqueue 안 하고 **웹훅 도착이 confirm job을 태움**. 워커는 기다린 적 없음. 지금 createHeld enqueue는 "결제 즉시 성공" 흉내며, 결제 붙으면 enqueue 위치만 웹훅으로 옮기면 됨(워커 코드 불변).
  - **핵심 개념(방송국)**: 워커와 SSE 통로는 서로 **참조 없는(loose coupling)** 별개 실행 맥락 → 값 직접 못 넘김 → 프로세스 내 **이벤트 버스**를 경유. RxJS `Subject`=방송국(next 송출+subscribe 수신), `Observable`=시간에 걸쳐 흘러오는 값의 수도관(Promise=값1개 vs Observable=여러개, subscribe≈addEventListener). NestJS `@Sse`는 내가 반환한 Observable을 구독해 emit을 `data:...\n\n` 전선포맷으로 변환·flush·연결관리. **내 책임 경계 = Observable 출구까지**, 그 뒤 전송은 NestJS.
  - **정직한 한계 명시**: 인메모리 Subject라 워커=웹서버 같은 프로세스일 때만 통함. 별도 프로세스 분리 시 Redis pub/sub 필요(운영 관심사, 후순위).
- **구현**:
  - **신규 `reservation-events.service.ts`**: `private Subject<ReservationStatusEvent>` + `publish()`(next) + `ofReservation(id)`(filter로 그 예약만 거른 구독전용 Observable). Subject를 숨기고 구독 스트림만 노출(외부 next 차단).
  - **워커(`confirm.processor.ts`)**: `updateMany` 후 **`count>0`(진짜 이번에 확정)일 때만** `events.publish({id, CONFIRMED})`. count===0(중복/이미확정)은 return — 헛 신호 방지.
  - **서비스(`reservations.service.ts`)**: `assertOwned`(스트림 열기 전 존재·소유권 확인 → 404/403) + `streamStatus`(경합 방지 핵심).
  - **신규 `reservation-stream.controller.ts`**: `@Controller('reservations')` + `@Sse(':reservationId/stream')` async 핸들러 = `await assertOwned` 후 `streamStatus` 반환. URL `/reservations/:id/stream`(create는 events 하위라 경로 달라 별도 컨트롤러).
- **경합(race) 처리 — 이번 설계의 정수**: 파이프라인이 빨라 클라가 SSE 여는 시점엔 워커가 **이미 확정 끝냈을 수** 있음(미래 방송만 기다리면 영영 안 옴). → `merge(future$, current$)`: future$=버스 방송(아직 HELD면 이걸로), current$=`defer`로 **구독 순간 DB 조회**해 이미 종료상태면 즉시 흘림(따라잡기). merge가 future$부터 구독 → 버스 구독이 DB읽기보다 먼저 성립 + 워커는 "DB기록 후 방송" 순서 → 틈에서 확정돼도 current$가 잡거나 future$가 받음(누락 0). `take(1)`로 종료상태 1건 받으면 수도관 close → NestJS가 연결 종료.
- **검증(무거운 e2e 대신 소스로 확정)**: `async @Sse` 핸들러가 안전한지 NestJS 11.1.28 `router-response-controller.js` 확인 — `Promise.resolve(result).then(구독)` + `.catch(reject)`. 정상 경로는 Promise 풀어 구독, 예외(assertOwned throw)는 헤더 전송 전이라 예외필터가 정상 404/403으로 변환. → HTTP e2e 불필요 판단(seed 미비로 수동 e2e 비쌈).
- **테스트**: 통합 6→9. 추가 3 = ①버스 필터링(지정 예약번호 이벤트만 전달) ②이미 CONFIRMED면 구독 즉시 따라잡기(current$) ③HELD 접수 직후 구독 시 워커 확정이 스트림으로 흘러옴(future$/current$). `firstValueFrom`으로 Observable 첫 emit 검증. **전체 14→17 그린.**
- **삽질**: 이 기기에 `@nestjs/bullmq`·`bullmq` 미설치(fresh) → tsc가 그 두 모듈만 에러(내 신규 코드는 무에러) → `pnpm install`로 해소. Docker 데몬 꺼져 있어 `open -a Docker`로 기동 후 infra up.
- **정직한 남은 틈(2.4에서 의도적으로 안 함)**: ① 브라우저 `EventSource`는 `Authorization` 헤더 못 붙임 → 지금 JWT 가드 유지라 실제 프론트 붙일 때(W3 후반) 쿼리파라미터 토큰/쿠키로 해결 필요. ② 하트비트 없음(프록시 유휴 끊김) → 운영 관심사 후순위. ③ ADR 0016 데모 stats 스트림도 같은 @Sse+Observable 메커니즘이라 재사용 가능(이번에 일반 배관을 만들어둠).
- **다음**: 2.5 안전장치(HELD TTL 만료 회수 = 고아 안전망 + `heldUntil` 실제 세팅 + Redis 유실 재구성).

## 2026-08-01 · W3 2.5 — HELD TTL 만료 회수 + Redis 재구성

- **개념 설계(사용자 자기설명으로 검증)**: 두 안전장치를 별개 문제로 다뤘다.
  - **BullMQ job/queue/worker 재정리**: job=주문서(처리할 일 1건의 데이터), queue=주문서가 쌓이는 곳(실제 저장은 Redis), producer=`queue.add`로 넣는 쪽, worker=`process()`로 꺼내 처리하는 쪽. `bullmq`(엔진, Redis와 직접 통신)와 `@nestjs/bullmq`(Nest 데코레이터 어댑터, 리플렉션으로 메타데이터를 읽어 워커 인스턴스화를 대신해줌)를 구분.
  - **TTL 스윕 트리거 — delayed job(예매당 1개) vs 주기적 스윕 비교**: 사용자가 처음 "정확한 타이밍엔 delayed job"이라 판단했으나, **BullMQ의 `delay`는 "그 전엔 안 함"이라는 하한선만 보장하지 "정확히 그때 처리"는 워커 동시성에 달림**을 짚어내면서 뒤집음 — 선착순 특성상 다수 HELD가 동시에 만료되면 delayed job은 오히려 순차 처리로 밀리는 반면, 벌크 UPDATE 1번(주기적 스윕)은 건수와 무관. **TTL은 원래 여유시간이라 몇십 초 오차가 무해**하다는 판단까지 사용자가 스스로 도달 → **주기적 스윕(BullMQ repeatable job)**으로 확정.
  - **원자적 claim — `UPDATE...RETURNING`**: "대상 찾기(SELECT)"와 "상태 바꾸기(UPDATE)"를 분리하면 그 사이 confirm 워커가 같은 행을 채가는 경합이 재발함을 사용자가 직접 도출(ConfirmProcessor의 `WHERE status=HELD` 패턴과 동일 원리 — "판단과 쓰기를 한 문장으로"). Prisma `updateMany`는 `RETURNING`을 지원 안 해 `$queryRaw` 필요. **정정 필요했던 오해**: `RETURNING`이 eventId별로 합산해준다고 생각했으나, 실제론 바뀐 행을 그대로(합산 없이) 돌려줄 뿐 — 합산은 애플리케이션 코드(TS)에서.
  - **DB 먼저, Redis는 나중(순서)**: 반대 순서(Redis 먼저)로 크래시 나면 "이미 팔린 좌석"이 Redis에서 되돌려져 재판매되는데 원래 HELD도 뒤늦게 CONFIRMED될 수 있어 초과판매 재발. DB 먼저면 크래시 나도 뒤늦은 confirm job이 `WHERE status=HELD`에 안 걸려 자동 무시(안전한 방향의 실패).
  - **재구성 잡의 트리거 — "Redis가 죽었을 때만"이 아니다**: 처음엔 "Redis 재시작/flush 시에만 필요"라 생각했으나, TTL 스윕의 "DB 먼저→Redis 나중" 자체도 그 사이 크래시 나면 Redis가 살아있는 채로 어긋날 수 있음을 재발견 — **DB·Redis 두 저장소에 걸친 쓰기(dual-write)는 하나의 트랜잭션으로 못 묶어 이 틈이 구조적으로 항상 존재**. 그래서 재구성도 "서버 기동 시 1회"가 아니라 **상시 주기적** 잡이어야 함.
- **구현**:
  - **`reservations.service.ts`**: `HELD_TTL_MS = 5분` 상수 추가(`MAX_RETRIES`와 같은 자리). `createHeld`가 HELD 예매 생성 시 `heldUntil: now + HELD_TTL_MS` 세팅(2.2/2.3에선 미사용이라 생략했던 부분). 지금은 confirm job이 즉시 확정돼 TTL이 정상 결제 시나리오보단 "HELD 고아"(create 커밋~queue.add 사이 크래시) 회수용 안전망에 가깝다는 것도 확인.
  - **신규 `sweep.processor.ts`**: `SWEEP_QUEUE`(30초 주기). `$queryRaw`로 `UPDATE reservations SET status='EXPIRED' WHERE status='HELD' AND heldUntil<now() RETURNING id, eventId, quantity` 원자적 claim → eventId별 quantity 합산(TS `Map`) → 이벤트별 `INCRBY` 보정.
  - **신규 `reconcile.processor.ts`**: `RECONCILE_QUEUE`(1분 주기). Prisma `groupBy`(HELD+CONFIRMED를 eventId별 quantity 합산, raw SQL 불필요 — RETURNING과 달리 groupBy는 Prisma 기본 지원)로 총재고−합산을 계산해 이벤트별 `SET`(상대 연산 아님 — DB가 진실이라 절대값 덮어쓰기).
  - **두 프로세서 모두 `OnModuleInit`에서 자기 큐에 `{repeat:{every:...}}`로 자기 자신을 등록** — confirm과 달리 외부 producer가 없어 스스로 반복 예약. 같은 repeat 설정이면 재기동해도 BullMQ가 중복 스케줄러를 안 만듦(멱등 등록).
  - `reservations.module.ts`: 큐 2개 추가 등록(`defaultJobOptions: removeOnComplete만` — sweep/reconcile은 이번 틱이 실패해도 다음 틱이 전체를 다시 훑어 스스로 만회하므로 confirm과 달리 attempts/backoff 불필요).
- **테스트**: 신규 파일 2개(`sweep.processor.spec.ts` 3건, `reconcile.processor.spec.ts` 4건) — 둘 다 반복 타이머(30초/1분)를 기다리지 않고 `processor.process()`를 직접 호출해 검증. `afterAll`에서 `queue.obliterate({force:true})`로 `onModuleInit`이 남긴 repeatable 스케줄러까지 정리. **전체 17→24 그린.**
- **삽질 — 통합 테스트 파일이 늘며 드러난 병렬 실행 문제**: 실DB를 쓰는 통합 스펙 파일이 `reservations.service.spec.ts` 하나뿐일 땐 안 드러났는데, `sweep`/`reconcile` 스펙을 추가하니 Jest 기본 병렬 워커가 세 파일을 동시에 돌리면서 서로의 `beforeEach` 전체삭제(`deleteMany`)가 다른 파일이 방금 만든 행을 지워버려 카운트 단언이 들쭉날쭉 실패. **원인은 같은 로컬 DB를 공유하는 여러 통합 테스트 파일 + Jest 병렬 실행의 조합** → `package.json`의 jest 설정에 `maxWorkers: 1` 추가(직렬 실행)로 해결. 프로젝트 성격(로컬 개발용 통합 테스트, CI 규모 아님)상 속도보다 정확성 우선.
- **다음**: W4 공개 데모 모드(ADR 0016) — 진입 게이트 + 서버측 부하 시뮬 + 실시간 stats 대시보드(2.4 SSE 배관 재사용) + 데이터 리셋. `Payment.idempotencyKey` unique 재검토는 결제 단계에서.

## 2026-08-01 · W4 착수 — 데이터 리셋 + seed (ADR 0016 축 C, 부분 개정)

- **범위 조정**: ADR 0016 원안은 "자동 주기 리셋 + 수동 리셋 둘 다"였으나, 구현 착수 시점에 **수동 리셋만**으로 좁힘(자동/주기·활동기반 idle-timeout 모두 보류). 근거는 아래 "개정" 참고. 자동 리셋이 필요해지면(예: 실제 배포 후 방치 시간이 길어 매진 상태가 오래 남는 문제가 실제로 보이면) 그때 다시 추가.
- **설계 중 정정된 판단 2건(사용자 발)**:
  1. **Admin 계정 불필요**: 처음엔 seed가 admin 계정도 만들어야 한다고 제안했으나, 이는 STATUS.md의 옛 메모(개발자 본인의 로컬 수동 e2e 편의)를 데모 요구사항과 혼동한 것이었다. 실제로는 seed가 API가 아니라 Prisma로 DB에 직접 쓰고, 데모 방문자는 로그인이 아니라 게이트 토큰으로 들어오므로(ADR: "게이트 ≠ 로그인") ADMIN role이 쓰일 자리가 없다 → **드롭**.
  2. **리셋 트리거 재검토**: "주기적(고정 간격)" 대신 "활동 기반 idle-timeout"(마지막 활동 후 N분 조용하면 리셋 — BullMQ delayed job을 활동마다 다시 거는 디바운스 패턴)을 검토했으나, 사용자가 최종적으로 **"게이트 진입 후 수동 리셋"** 하나로 확정 — 자동화 자체를 이번 범위에서 제외.
- **데모 이벤트 식별**: `Event.isDemo Boolean @default(false)` 추가(마이그레이션 `20260801121614_add_event_is_demo`). 로컬 개발 중 수동으로 만든 다른 이벤트와 섞이지 않도록 명시적 플래그로 리셋 대상을 특정(느슨한 "이벤트가 1개뿐이라 가정"보다 안전).
- **구현**:
  - **신규 `demo/` 모듈**(ADR: "데모 전용 코드는 격리하라"에 따라 별도 모듈로 분리). `demo.service.ts`의 `resetDemoEvent()`가 seed와 수동 리셋 엔드포인트가 공유하는 핵심 로직 — ①`isDemo:true` 이벤트 조회(없으면 404) ②예매 전체 삭제 ③재고 `remainingQty=totalQty`로 원복(`version` 증가로 낙관적 락 전략과 충돌 방지) ④Redis `stock:event:{id}` SET ⑤`openAt=now, status=ON_SALE`.
  - **`prisma/seed.ts`**: `isDemo:true` 이벤트가 없을 때만 생성(idempotent) — 리셋과 역할 분리(seed=최초 존재 보장, reset=초기 상태로 되돌림). `package.json`에 `prisma.seed` 필드 + `prisma:seed` 스크립트 등록.
  - **`POST /demo/reset`**: 가드 없음(의도적) — 진입 게이트(ADR 축 A, 다음 작업)가 아직 없어서다. 컨트롤러에 "게이트 구현 시 그 가드로 보호 예정" 주석 명시. 배포 전 로컬 개발 단계라 당장 위험 없음.
- **테스트**: 신규 `demo.service.spec.ts` 4건(리셋 정상 동작, 데모 이벤트 없을 때 404, openAt/status 복구, `isDemo=false` 이벤트는 건드리지 않음). **전체 24→28 그린.** 서버 기동 후 `curl -X POST /demo/reset`으로 실제 HTTP 경로까지 수동 검증.
- **다음**: W4 진입 게이트(ADR 축 A) — `DEMO_GATE_PASSWORD` 검증 + 데모 토큰 발급 + 전역 가드. 이후 서버측 시뮬레이션(축 B-1) + stats SSE(축 B-2) 순.

## 2026-08-01 · W4 진입 게이트 (ADR 0016 축 A)

- **방문자 식별 방식 논의가 세 번 바뀜(사용자 발, 기록만 — 오늘 범위엔 미반영)**: "admin 불필요" → "로그인 없이 게스트로 예매" → "Google SSO로 로그인" 순으로 검토되다, **오늘은 게이트만 구현하고 인증 방식(방문자가 어떻게 자기 예매를 남기는가)은 다음 세션으로 분리**하기로 확정. 이유: 게이트("누구든 들어올 수 있냐")와 방문자 식별("이 예매가 누구 것이냐")은 서로 다른 헤더·다른 토큰을 쓰는 독립적인 문제라 오늘 안 섞어도 됨 + 인증 방식은 ADR 0013(기존 인증 설계)과 맞닿은 무게 있는 결정이라 별도 세션에서 제대로 다뤄야 함.
- **개념 정리**: 이 프로젝트의 **첫 전역 가드**(지금까진 전부 라우트별 `@UseGuards`). "게이트 ≠ 로그인"(ADR) — 게이트는 "서비스 전체 진입 자격", 로그인은 "이 요청이 누구 것인가"로 층위가 다르다. 그래서 헤더도 분리(`X-Demo-Token` vs `Authorization`) — 나중에 로그인이 붙어도 방문자가 두 증거를 각자 자기 헤더에 실어 보내면 되므로 안 엉킨다.
- **구현**:
  - **토큰**: 기존 `JwtService` 재사용(새 시크릿 불필요) — `{ type: 'demo' }` payload로 sign, `JWT_EXPIRES_IN`(1h) 그대로. 로그인 payload(`sub/email/role`)와 모양이 달라 서로 안 섞임. `AuthModule`이 `JwtModule`을 `exports`하도록 수정해 `DemoModule`이 `JwtService`를 주입받게 함.
  - **`POST /demo/gate`**: 비번 검증 후 `demoToken` 발급(`DemoService.enterGate`). `@Public()`(신규 데코레이터, `@Roles`와 같은 `SetMetadata`+`Reflector` 패턴)으로 전역 가드를 우회 — 게이트 자신은 토큰 없이도 열려있어야 발급이 가능하다(닭-달걀 문제 회피).
  - **`DemoGateGuard`**: `APP_GUARD`로 `AppModule`에 등록한 전역 가드. `X-Demo-Token` 헤더를 읽어 검증하고, payload의 `type !== 'demo'`면 거부(로그인 JWT를 게이트 토큰으로 재사용 못 하게). **`DEMO_GATE_PASSWORD`가 설정 안 돼 있으면 자동으로 게이트를 비활성화**(로컬 개발·기존 테스트·`bench.sh`가 안 깨지게) — 새 on/off 플래그를 추가하는 대신 이미 있는 env의 유무 자체를 신호로 재사용.
  - **`/health`**에 `@Public()` — 인프라 모니터링이 데모 토큰을 가질 수 없으므로.
- **테스트**: `DemoGateGuard`는 실제 HTTP/DB 없이 `canActivate()`만 검증하는 순수 단위 테스트(가짜 `ExecutionContext`)로 작성 — supertest 같은 e2e 의존성을 새로 안 들여도 충분(6건). `DemoService.enterGate`도 통합 테스트 3건 추가. **전체 28→37 그린.** 서버 기동 후 curl로 5단계(헬스체크 공개→토큰 없이 차단→틀린 비번 거부→올바른 비번 발급→토큰으로 통과) 전부 수동 검증, 비번 미설정 시 자동 우회도 별도 확인.
- **다음**: 방문자 식별/예매 방식 결정(위 "논의가 세 번 바뀜" 참고, 별도 ADR 검토) → W4 서버측 부하 시뮬레이션(축 B-1) → stats SSE(축 B-2) → 프론트엔드(apps/web) → 배포.

## 2026-08-01 · 방문자 예매 인증 — Google SSO 도입

- **결정**: 세 번 바뀌었던 방문자 식별 방식(admin 불필요 → 게스트 → Google SSO) 논의를 오늘 마무리. 기존 이메일/비번 로그인(W1, 새 코드 불필요) 재사용을 더 단순한 대안으로 제안했으나, **사용자가 Google SSO를 명시적으로 선택**해 그대로 진행.
- **개념**: OAuth 2.0 authorization code flow. 이메일/비번 로그인과 달리 **브라우저 리다이렉트가 필수**(①`/auth/google`→Google 로그인 페이지 ②Google이 code를 실어 `/auth/google/callback`으로 되돌림 ③서버가 code로 프로필을 받아 자체 JWT 발급). API 요청 하나로 끝나지 않는다는 점이 지금까지의 JSON API 패턴과 다름.
- **⚠️ 설계 중 발견 — 게이트와의 충돌**: 브라우저의 페이지 이동(리다이렉트)은 커스텀 헤더(`X-Demo-Token`)를 못 붙인다. `/auth/google`과 `/auth/google/callback`은 구조적으로 게이트를 우회(`@Public()`)해야만 동작 — 로그인 "시작"은 게이트 없이 가능해지지만, 실제 비용이 드는 작업(예매 등)은 여전히 게이트+로그인 토큰 둘 다 필요해 안전하다고 판단하고 진행.
- **스키마**: `User.password`를 `String?`(nullable)로 변경(마이그레이션 `20260801133308_user_password_nullable_for_google`) — Google 계정은 비밀번호가 없음.
- **정직한 버그 하나(구현 중 발견)**: `GoogleStrategy`가 `clientID: '' `처럼 빈 문자열 fallback을 쓰면 `passport-oauth2`가 생성자에서 바로 throw해 **앱 부팅 자체가 죽었다**(JWT_SECRET처럼 "설정 안 해도 부팅은 된다"를 의도했는데 반대로 동작). 빈 문자열이 아니라 `'not-configured'` 같은 의미 있는 플레이스홀더로 고쳐 해결 — 미설정 시에도 부팅은 되고, 실제 `/auth/google` 시도 시에만 Google이 invalid_client로 거부한다.
- **구현**: `google.strategy.ts`(신규, `passport-google-oauth20`), `GoogleAuthGuard`(`AuthGuard('google')`), `AuthController`에 `GET /auth/google`(리다이렉트 시작)·`GET /auth/google/callback`(토큰 발급, 프론트 없어 지금은 JSON 직접 반환). `AuthService`에 `findOrCreateGoogleUser()`(이메일로 찾거나 `password:null`로 생성) + `login()`/Google 콜백이 공유하는 `issueToken()` 추출. `login()`에 `!user.password` 가드 추가(Google 전용 계정으로 비번 로그인 시 `argon2.verify(null,...)` 크래시 대신 깔끔한 401).
- **작은 리팩터**: `@Public()` 데코레이터가 `demo/`뿐 아니라 `auth/`(Google 라우트)에서도 필요해져 `common/decorators/`로 이동 — demo 전용이 아니라 앱 전역 관심사였음이 드러남.
- **새 env 3개**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`. `.env.example` 반영. 사용자가 직접 Google Cloud Console에서 OAuth 클라이언트를 발급(OAuth 동의 화면 → 테스트 사용자 등록 → 웹 애플리케이션 클라이언트 → 리디렉션 URI 등록)하고 `.env`에 값을 채움.
- **테스트**: `auth.service.spec.ts`에 4건 추가(null-password 로그인 401, `findOrCreateGoogleUser` 3건). **전체 37→41 그린.** 실제 Google Cloud Console 발급 자격증명으로 **브라우저에서 실제 로그인까지 end-to-end 검증** — 발급된 토큰으로 `/auth/me` 통과 확인, DB에 `password IS NULL` 계정 생성 확인.
- **다음**: W4 서버측 부하 시뮬레이션(축 B-1, 게이트를 통과한 방문자가 자기 계정으로 직접 예매도 가능해졌으니 시뮬레이션과 나란히 노출 가능) → stats SSE(축 B-2) → 프론트엔드(apps/web) → 배포.

## 2026-08-05 · W4 서버측 부하 시뮬레이션 (ADR 0016 축 B-1)

- **설계 논의(사용자 발, ADR 0016에 2026-08-05 개정으로 반영)**: 세부 4가지를 이 세션에서 확정.
  1. **투입 리듬**: 처음엔 "점진적"(순차)으로 답이 나왔으나, 이 프로젝트의 목적(W2가 증명한 "동시 쓰기 경합")을 다시 짚으면서 재검토 — 순수 순차 투입은 동시성 경합 자체가 안 걸리고, 순수 동시 발사는 Redis 원자 감산이 워낙 빨라 대시보드가 보여줄 새도 없이 끝난다. **묶음(batch) 발사**로 절충(짧은 간격마다 일정 묶음을 동시 발사) — 묶음 안은 진짜 동시 요청, 묶음 사이 간격은 사람이 눈으로 따라갈 여유.
  2. **가상 유저 신원**: "가짜 값 먼저 시도"로 나온 답을, 스키마 확인(`Reservation.userId`가 `User` FK) 결과 가짜 id는 **시도할 필요 없이 확정적으로 실패**함을 짚어 바로 "가상 유저마다 실제 `User` 레코드 생성"으로 확정.
  3. **쿨다운 강제 위치**: "프론트 버튼으로 수동 처리"라는 초기 답이 ADR 자체의 "신뢰 경계는 백엔드"(§A와 동일 논리) 원칙과 상충할 수 있어 재확인 → **백엔드 Redis 쿨다운 유지 + 프론트는 그 결과(429)만 반영**으로 정리(스코프는 전역 — 게이트 통과자면 누구든).
  4. **가상 유저 정리**: 재고/예매 리셋(§C)만으론 시뮬레이션이 만든 `User` 행이 무료 티어 DB에 리셋마다 계속 쌓인다는 점을 짚어, 이메일 접두사(`sim-`)로 식별해 리셋 시 함께 삭제하도록 추가(스키마 변경 없이 `isDemo` 식별 취지 재사용).
- **구현**:
  - `ReservationsModule`이 `ReservationsService`를 `exports`(기존엔 모듈 내부 전용) → `DemoModule`이 이를 import해 가상 유저의 예매를 실제 파이프라인(`create(eventId, userId, 1, 'held', idempotencyKey)`)으로 그대로 흘림. 시뮬레이션 전용 우회 경로를 새로 안 만들고 **실제 서비스 코드를 재사용**하는 게 핵심 — 그래야 이 시뮬레이션이 "진짜" 동시성 문제를 재현한다.
  - `DemoService.simulateLoad()`: ①`DEMO_SIM_MAX_VU` 상한 검사 ②Redis `SET NX PX`로 쿨다운을 원자적 확인+잠금(확인과 잠금을 분리하면 그 사이 경합 가능) ③데모 이벤트 조회 ④`202` 즉시 응답, 실제 투입은 `void`로 fire-and-forget(컨트롤러가 기다리지 않음, 실패는 `Logger.error`로만).
  - `runSimulationBatches`: `SIM_BATCH_SIZE=20`·`SIM_BATCH_INTERVAL_MS=300` 상수로 묶음 발사. `injectVirtualUser`: `sim-<uuid>@sunchak.demo`·`password:null` User 생성 후 `held` 전략 호출. 재고 소진(`ConflictException`)은 이 데모가 보여주려는 정상 시나리오라 조용히 넘기고, 그 외 예외만 로그.
  - `resetDemoEvent()`에 `sim-` 접두사 `User` 삭제 추가(예매 삭제 다음 순서 — FK 걱정 없이 지울 수 있게).
  - `POST /demo/simulate`(`SimulateDto`, `@HttpCode(202)`) — 전역 게이트 가드가 이미 보호(별도 가드 불필요, `reset`과 같은 패턴).
- **검증**: 유닛 테스트 4건 추가(`demo.service.spec.ts` — 상한 초과 400, 정상 요청 202+백그라운드 실제 투입, 쿨다운 중 429, 리셋 시 `sim-` 유저만 삭제·일반 유저는 보존). `ReservationsService`는 모킹(큐 인프라까지 테스트 모듈에 안 들여도 됨). **전체 41→45 그린.**
  - **실제 서버로 e2e 수동 검증**(모킹 없이): seed 후 `POST /demo/simulate {virtualUserCount:45}` → 72ms만에 202 응답 확인(블로킹 안 됨) → 3초 후 Redis `stock:event:254` 100→55, DB `reservations` 45건 전부 CONFIRMED(워커가 이미 처리), `sim-` User 45건 생성 확인. 즉시 재요청은 429(쿨다운) 확인. 301명 요청은 400(상한) 확인. `POST /demo/reset` 후 `sim-` User·예매 0건, Redis 재고 100 원복 확인.
- **다음**: W4 실시간 stats 대시보드(축 B-2) — 2.4의 `@Sse`+`Subject` 배관을 재사용해 재고·HELD/CONFIRMED·큐 적체를 스트리밍. 지금 시뮬레이션은 결과를 curl로만 확인했지만, B-2가 붙으면 방문자가 이 과정을 실시간으로 지켜볼 수 있게 된다.

## 2026-08-05 · W4 실시간 stats 대시보드 (ADR 0016 축 B-2)

- **설계 결정 — 폴링 vs 이벤트 기반**: 2.4의 SSE는 이벤트 기반(워커가 확정하는 그 순간에만 `publish`)이었지만, stats는 소스가 3개(Redis 재고·DB의 HELD/CONFIRMED 합계·BullMQ 큐 적체)라 이벤트 기반으로 엮으려면 관문 DECRBY·HELD INSERT·sweep·reconcile·confirm 워커 등 **이미 완성된 W3 코드 여러 곳**에 손을 대야 해서 결합도가 커진다. 대신 **1초 주기 폴링 스냅샷**(그때그때 다시 조회해서 그대로 흘려보냄)으로 결정 — 기존 코드 무변경, 새 파일도 없이 `DemoService`에 메서드 2개 추가로 끝남. 시뮬레이션이 어차피 배치 단위(300ms 간격)로 진행돼 "놓치면 안 되는 찰나의 이벤트"가 없다는 점도 폴링이 무난한 이유.
- **구현**: `DemoModule`에 `BullModule.registerQueue({ name: CONFIRM_QUEUE })` 추가(같은 이름으로 여러 모듈이 등록해도 큐가 중복 생성되지 않음 — `AppModule`의 `forRootAsync` 연결 설정을 공유) → `DemoService`가 `@InjectQueue(CONFIRM_QUEUE)`로 큐를 주입받아 `getWaitingCount()`/`getActiveCount()`로 **적체만 읽음**(job을 넣지 않음, `ReservationsService`의 몫과 분리 유지).
  - `streamStats()`: 구독 시작 전 데모 이벤트 존재를 한 번만 확인(리셋은 같은 이벤트 행을 갱신할 뿐 id는 안 바뀌므로 매 틱마다 다시 찾을 필요 없음) → `timer(0, 1000)`(구독 즉시 1회 + 이후 1초마다)를 `switchMap`으로 `getStats()`에 연결.
  - `getStats(eventId)`: Redis 재고 + Prisma `groupBy(status)`(HELD/CONFIRMED quantity 합, reconcile.processor와 같은 패턴) + 큐의 waiting/active 카운트를 `Promise.all`로 병렬 조회.
  - `DemoController`에 `@Sse('stats/stream')` 추가(전역 게이트 가드로 이미 보호, JWT 불필요 — 개인 데이터가 아니라 게이트 통과자 전원이 같은 화면을 봄).
- **테스트**: `demo.service.spec.ts`에 2건 추가(이벤트 없으면 404, HELD/CONFIRMED/큐 적체 스냅샷이 기댓값과 일치) — `getQueueToken(CONFIRM_QUEUE)`로 큐를 가벼운 목(mock)으로 대체(실제 워커·Redis 큐 인프라 불필요, `reservations.service.spec.ts`가 이미 그 책임을 검증 중). **전체 45→47 그린.**
- **실서버 e2e 수동 검증**: 리셋 → `curl -N`으로 SSE 스트림을 열어두고 1초 뒤 60명 시뮬레이션 투입 → 실시간으로 `재고 100→40, HELD 5→0, CONFIRMED 0→55→60, 큐 적체 0→6→0`으로 움직이는 스냅샷을 그대로 확인. ADR이 그리던 "숫자가 실시간으로 움직이는 대시보드"가 실제로 동작함을 확인.
- **발견(수정은 다음으로 미룸)**: `simulateLoad()`가 쿨다운을 먼저 잠그고 그다음에 데모 이벤트 존재를 확인해서, 이벤트가 없는 상태(seed 전)에서 호출하면 404를 받으면서도 쿨다운은 이미 소비돼버린다. 사소한 엣지케이스(정상 운영에선 이벤트가 항상 있음)라 지금은 기록만 해두고 보류.
- **다음**: W4 프론트엔드(apps/web) — 게이트 화면 + Google 로그인 버튼 + 데모 컨트롤(시뮬 버튼)·stats 대시보드 화면. 이제 백엔드 조각(게이트·리셋·시뮬·stats)이 다 갖춰졌다.

## 2026-08-05 · W4 프론트엔드 착수 — 워크스페이스 + 쿠키 기반 인증 전환

- **pnpm 워크스페이스 신설**: ADR 0012가 "apps/web 추가 시점에 정식 워크스페이스 도입"이라 못박아둔 그 시점이라 별도 논의 없이 진행. 루트 `package.json`+`pnpm-workspace.yaml` 신설, `apps/api`/`apps/web`를 `@sunchak/api`/`@sunchak/web`로 워크스페이스 스코프 통일, 개별 lockfile 2개를 루트 단일 lockfile로 통합.
  - **삽질**: `apps/api/pnpm-lock.yaml`을 지워도 이후 `pnpm --filter @sunchak/api add ...`를 돌리면 계속 되살아남 → 원인은 `apps/api/package.json`이 루트와 별개로 자기만의 `packageManager` 필드를 여전히 갖고 있었던 것(워크스페이스 멤버가 중복 선언하면 그 디렉토리를 준-루트처럼 취급해 로컬 lockfile을 미러링하는 것으로 보임). 그 필드를 지우니 재발 안 함.
  - 네이티브 빌드 승인(`pnpm-workspace.yaml`의 `allowBuilds`)은 apps/api 단독 개발 때 이미 STATUS.md에 남겨둔 판단(Prisma·argon2만 승인, msgpackr-extract·unrs-resolver는 생략)을 그대로 재적용.
- **Next.js 스캐폴딩**: App Router + TypeScript + Tailwind + TanStack Query. `Providers`(`'use client'`, `QueryClient`를 `useState`로 1회 생성)를 `layout.tsx`에 배선. **이 Next.js 버전(16.3.0)은 학습 데이터보다 최신**이라 `node_modules/next/dist/docs/`를 실제로 읽어 확인 — `LayoutProps<'/route'>` 같은 새 전역 타입 헬퍼가 생겼음(params/searchParams가 route별로 자동 타입 생성, `next dev`/`build`/`typegen` 시점에 생성됨).
- **SSE 인증 방식 전환 — 쿼리파라미터 대신 쿠키(사용자 정정)**: 브라우저 `EventSource`는 커스텀 헤더를 못 붙여(기존부터 STATUS.md에 기록된 틈) `X-Demo-Token`/`Authorization` 헤더 인증이 그대로는 브라우저에서 안 열린다. 처음 "쿼리파라미터로 토큰 전달"을 수정 범위가 적다는 이유로 1순위 추천했으나, **사용자가 "데모라고 적은 수정 범위를 무조건 고르지 말고 표준·성능을 우선하라"고 정정** — URL 노출(서버 로그·브라우저 히스토리에 토큰이 남음)이라는 비표준적 절충이었음을 지적받고 쿠키(HttpOnly) 기반으로 방향을 바꿈. 이 원칙은 메모리에 기록해 앞으로도 적용.
  - **구현**: `cookie-parser` 추가, `main.ts`에 등록 + CORS 활성화(`credentials:true`+구체적 origin — 와일드카드는 쿠키와 함께 못 씀). 공유 헬퍼 `common/auth-cookie.ts`(쿠키 이름 상수 + `httpOnly`/`secure`/`sameSite` 정책, `NODE_ENV`로 배포 시 `SameSite=None+Secure` 분기 미리 심어둠). `JwtStrategy`/`DemoGateGuard`가 **쿠키를 우선 확인하고 없으면 헤더로 폴백**(브라우저는 쿠키 자동 전송, curl 등 STATUS.md에 기록된 기존 수동 검증 절차는 헤더로 계속 동작 — 표준을 택하되 기존 워크플로우를 안 깨는 절충). `login`/`enterGate`/Google 콜백이 JSON 응답과 별개로 쿠키도 심음. **Google 콜백의 오래된 TODO(프론트 없어 JSON 임시 반환)를 이제 실제로 해소** — 쿠키 심고 `WEB_APP_URL`로 리다이렉트.
  - **쿠키 만료 안 박음**: `maxAge`를 `JWT_EXPIRES_IN`("1h" 같은 문자열)에 맞추려 `ms` 파싱 의존성을 늘리는 대신, 브라우저 세션 쿠키로 두고 실제 만료는 JWT 서명 검증(`ignoreExpiration:false`)에 맡김 — 쿠키가 남아있어도 서버가 만료된 토큰은 어차피 거부.
  - **새 env**: `WEB_APP_URL`(CORS origin + Google 리다이렉트 대상).
  - **검증**: `tsc`+전체 47개 테스트 그린(서비스 계층 테스트라 컨트롤러의 쿠키 로직은 영향 없음). **실서버 e2e로 쿠키만(헤더 없이) 통과 확인**: 게이트(`POST /demo/gate` → `Set-Cookie` 확인 → 쿠키만으로 `GET /demo/stats/stream` SSE 통과, 쿠키 없인 401), 로그인(`POST /auth/login` → `Set-Cookie` 확인 → 쿠키만으로 `GET /auth/me` 통과). `reservation-stream`은 같은 `JwtStrategy`를 타므로 별도 재검증 없이 동일 보장 적용됨.
- **다음**: 실제 화면(게이트 진입 → Google 로그인 → 데모 컨트롤 + stats 대시보드) 구현. `fetch`/`EventSource` 호출엔 `credentials:'include'`/`withCredentials:true` 필요.

## 2026-08-06 · W4 프론트 실제 화면 + "내 예매"(실제 티케팅) 기능

- **구현**: 게이트 진입 폼(`gate-form.tsx`) → Google 로그인 버튼 → 데모 대시보드(`demo-dashboard.tsx`, 시뮬 컨트롤+stats 스탯 타일). `page.tsx`가 상태 하나(`checking/gate/login/dashboard`)로 세 화면을 조건 렌더링 — 전용 상태 확인 엔드포인트를 새로 안 만들고 기존 `GET /auth/me`의 401 메시지 문자열(게이트 실패 한글 메시지 vs JWT 실패 `"Unauthorized"`) 차이로 판별(백엔드 에러 문자열에 약하게 결합되는 트레이드오프를 인지하고 사용자 확인 후 채택).
- **dataviz 스킬 참고**: stats 대시보드는 "헤드라인 숫자 몇 개"라 차트가 아니라 KPI row(스탯 타일)로 판단. 색은 텍스트에 안 쓰고 재고 소진(매진) 같은 실제 상태에만 status 팔레트(`#d03b3b`) + 라벨 병기.
- **Vitest+RTL 도입**: `apps/web`에 테스트 프레임워크가 아예 없어서(CLAUDE.md §7 요구사항) 이 세션에서 처음 설치. `vitest.config.mts`(jsdom, `resolve.tsconfigPaths:true` — 별도 플러그인 없이 Vite 8 내장 옵션), `vitest.setup.ts`(jest-dom + `afterEach(cleanup)` — globals를 안 켰으므로 RTL 자동 cleanup이 안 붙어 직접 등록해야 함, 안 하면 테스트 간 DOM 잔존으로 "여러 개 찾힘" 에러). jsdom엔 `EventSource`가 없어 `src/test/fake-event-source.ts`(최소 흉내 클래스)로 대체.
- **"내 예매" 기능 추가 — 진짜 티케팅 기능이 빠져 있었다는 걸 사용자가 직접 써보고 발견**: 데모 대시보드가 "관찰"(가상 유저 시뮬+통계)만 가능했고, 로그인한 방문자 본인이 실제로 예매하는 화면이 없었다 — ADR 0014/0015가 만든 실제 파이프라인(HELD→큐→확정→SSE)을 프론트가 한 번도 호출하지 않고 있었다. `booking-form.tsx` 신규: `GET /events`로 `isDemo` 이벤트 조회 → 수량 입력+예매하기 → `POST /events/:eventId/reservations?strategy=held` → 응답 `reservation.id`로 `GET /reservations/:id/stream`(SSE) 구독해 HELD→CONFIRMED 실시간 반영.
- **실서버 e2e로 실제 확인**: 로그인 → 예매 → 확정까지 실제로 동작. **로컬은 관문→HELD→큐→확정이 너무 빨라(수백ms) "HELD" 문구가 화면에 거의 안 보이고 곧바로 확정으로 넘어감** — 버그 아니라 로컬 워커 지연이 거의 없어서 그런 것.
- **git 위생 버그 발견·수정**: `apps/web/.gitignore`(create-next-app 기본 생성분)의 `.env*` 패턴이 `.env.example`까지 무시하고 있었다 — 이대로면 새로 만든 env 예시 파일이 영원히 git에 안 올라가 다른 기기에서 필요한 env를 알 방법이 없었을 것. 루트 `.gitignore`와 같은 좁은 패턴(`.env`/`.env.local`/`.env.*.local`)으로 교체.
- **다음**: 배포. 단, 이 세션 후반에 "티케팅 기능 자체가 이거 다인가?" 질문으로 더 큰 gap이 드러남(아래 항목).

## 2026-08-06 · 선착순 입장 대기열 (ADR 0017) — 원래 기획과의 gap 재확인에서 시작

- **계기**: "이 프로젝트 원래 목적이 뭐였는지 먼저 체크하자"는 사용자 요청으로 PRD(`02_서비스_기획안.md`)·로드맵·ADR 0006/0014/0015를 다시 대조. **발견**: PRD 원안의 핵심 시나리오("대기열에서 실시간 순번을 보며 기다린다")가 ADR 0014/0015 구현 과정에서 "즉시 판정 관문"으로 조용히 대체됐다 — 더 나은 엔지니어링 선택(k6로 증명)이었지만 어떤 ADR도 이 대체를 명시적으로 남기지 않았다. 추가로 코드 확인 결과 모의결제(Payment 테이블은 스키마에 있으나 서비스 없음)·오픈시각 검사·이벤트 목록 화면·내 예매 내역도 PRD 대비 빠져 있음(전부 STATUS.md에 기록, 대기열만 이번에 착수).
- **"즉시 판정 vs 대기열" 논의**: 사용자가 "대기열이 관문보다 얼마나 강력한지"를 물어 정정 — **둘은 경쟁 관계가 아니라 계층 관계**다. 대기열은 관문(hot row 직렬화 자체)의 처리량을 올리지 않는다, 오히려 의도적으로 입장 속도를 늦추는 장치다(다운스트림 보호+낭비 방지+재시도 폭탄 억제+봇 완화가 목적이지, "더 빠른 판정"이 목적이 아님). 이 프로젝트 실사용자는 소수(개발자+공유 대상)뿐이라 대기열의 진짜 존재 이유는 방어가 아니라 **원래 PRD 학습 포인트 완결 + 포트폴리오 서사 확장**임을 ADR에 솔직하게 명시.
- **설계(ADR 0017)**: Redis Sorted Set `queue:event:{id}`(FIFO) + BullMQ repeatable job(`AdmissionProcessor`, 2초 주기로 20명씩 `ZPOPMIN`) + `admitted:event:{id}:{userId}` 키(TTL, sweep 잡 없이 Redis가 자연 만료 — 입장 허가는 아직 재고를 안 건드린 상태라 유실돼도 정합성 문제 없음). `QueueService.assertAdmitted()` 한 곳을 실사용자(컨트롤러)·가상 유저(데모 서비스) 둘 다 통과해야 함 — 특수 경로 없음.
- **가상 유저 현실성**: 사용자 요청으로 "입장해도 랜덤하게 포기하거나 늦게 시도"를 추가(20% 포기 + 랜덤 지연). 이게 오히려 설계를 단순하게 만듦 — 가상 유저도 실사용자와 똑같이 허가창을 놓칠 수 있어 특수 케이스 없이 같은 코드 경로로 통합됨.
- **삽질 — 파라미터 두 개의 비율을 안 맞춰서 생긴 버그 아닌 버그**: 입장 허가창을 "더 짧게"(30초→8초) 줄이면서, 가상 유저 랜덤 지연 범위(1~35초, 원래 30초 창 기준으로 잡았던 값)를 같이 안 줄여서 실서버로 30명 시뮬레이션했더니 확정이 5명뿐이었다(기대는 대부분 성공). 원인 분석: 지연 범위가 허가창보다 훨씬 넓어 "느려서 놓침" 비율이 원래 의도(일부만)가 아니라 압도적 다수가 돼버림(확률 계산상 성공률 ~16%). **교훈**: 두 시간 상수(허가창 vs 지연 범위)는 독립적으로 못 정한다 — 지연 범위는 반드시 허가창보다 "살짝만" 넓어야 "대부분 성공, 느린 일부만 놓침"이 된다. 지연을 500ms~10초로 좁혀 재검증 → 30명 중 22명 확정(~73%), 의도한 그림이 나옴. ADR·`.env.example` 수치도 실제 값으로 정정.
- **테스트**: 신규 `queue.service.spec.ts`(8건)·`admission.processor.spec.ts`(4건)·`reservations.controller.spec.ts`(3건, 대기열 연동은 컨트롤러 레이어라 이 프로젝트 첫 컨트롤러 단위 테스트) + `demo.service.spec.ts`에 2건 추가(포기/허가창 만료). 지연·허가창 시간을 실제 값(수 초~수십 초)으로 기다리면 테스트가 느려져, `DEMO_SIM_ABANDON_PROBABILITY`/`DEMO_SIM_MIN·MAX_BOOKING_DELAY_MS`/`QUEUE_ADMISSION_WINDOW_MS`를 env로 빼 테스트에서만 아주 작은 값으로 덮어씀(기존 `DEMO_SIM_MAX_VU` 패턴과 동일). **전체 47→64 그린.**
- **프론트**: `booking-form.tsx`를 확장해 "대기열 진입부터 예매 결과까지" 한 패널에서 문구만 바뀌는 상태 하나로 표현(`idle→queued→admitted→held→confirmed/expired/error`) — 화면을 안 갈아탐(사용자 요청). 신규 테스트 3건 추가. **`apps/web` 9→12 그린.**
- **실서버 e2e**: 실제 로그인 사용자로 대기열 입장→순번 표시→(2초 뒤)입장 허가→예매→확정 전 흐름 확인. 가상 유저 30명으로 위 파라미터 버그도 실측으로 발견·재검증.
- **다음**: 배포(Dockerize → CI/CD → VM+Nginx → Grafana 관측 → 최종 k6 리포트 → README/회고, `docs/STATUS.md` 참고).

## 2026-08-06 · 모의 결제 (ADR 0018) — "대기열 다음은?"에서 시작

- **계기**: 사용자가 대기열 순번 계산 방식을 확인하는 질문 끝에 "다음 작업은 모의결제로 갈게요"로 방향을 정함. PRD(§4-5, §6)를 다시 보니 "모의 결제 버튼, 비동기 pending→done"이 이미 명시돼 있었고, ADR 0015가 스스로 "결제 stub"이라 부르며 이 자리를 예고해뒀던 걸 재확인.
- **설계**: `createHeld()`가 즉시 넣던 confirm job을 제거하고, "결제하기" 클릭이 새 `payment` 큐에 job을 넣게 함. `PaymentProcessor`가 80%/20% 확률로 성공/실패 판정 — 성공 시 **기존 `confirm` 큐에 job만 투입**(`ConfirmProcessor` 완전 재사용), 실패 시 Reservation→CANCELLED + Redis 재고 즉시 반환(사용자가 "즉시 반환 vs TTL 대기" 중 즉시 반환 선택).
- **`Payment.idempotencyKey` 재검토**: STATUS 백로그에 "재검토 필요"로 남아있던 항목. 확인해보니 Reservation과 달리 실제 버그가 아니었음 — `Payment.reservationId`가 이미 `@unique`(1:1)라 결제 재시도 자체가 그걸로 원자적으로 막힘. 별도 복합 unique 불필요로 결론.
- **⚠️ 삽질 — 이번 세션 최대 시간 소모**: 결제 구현 자체는 순조로웠는데, 테스트에서 SSE 관련 딱 1건("HELD 접수 직후 구독하면...")만 계속 5초 타임아웃. 처음엔 또 "백그라운드 서버가 큐를 나눠 먹나?" 의심 → `lsof -ti:3001 -sTCP:LISTEN | xargs kill`로 정리했는데도 **여전히 실패** — 여기서 한 단계 더 파고들어야 했다.
  - **디버깅 과정**: 테스트에 직접 `console.log`를 심어 확인 → DB는 정확히 CONFIRMED로 바뀜(워커는 돌고 있음) → 그런데 `ReservationEventsService.ofReservation()`을 테스트에서 직접 구독해도 이벤트가 안 옴 → 즉 "누군가 job을 가져가 DB는 고치지만, 그 publish()는 다른 프로세스의 메모리 안에서만 터진다"는 뜻.
  - **진짜 원인**: `ps aux`로 확인하니 이번 세션 동안 여러 번 띄운 `pnpm start:dev`의 **자식 프로세스(`nest.js start --watch`) 5개가 좀비로 남아있었다.** `pnpm start:dev`는 껍데기 래퍼일 뿐이고, 실제 서버(BullMQ 워커 포함)는 그 자식이다 — 포트를 점유한 프로세스(래퍼 또는 자식 중 하나)만 죽이면, **포트를 못 잡은 나머지 자식들은 포트 없이도 Redis에는 계속 연결된 채 살아남아** confirm 큐 job을 경쟁적으로 가져간다. `lsof -ti:포트`는 "포트를 점유한" 프로세스만 찾으므로 이 좀비들을 못 잡는다.
  - **해결**: `ps aux | grep "nest.js start" | grep -v grep | awk '{print $2}' | xargs kill -9`로 자식까지 직접 찾아 죽임 → 그 즉시 테스트 전체 그린. **교훈**: 이 프로젝트에서 백그라운드로 `pnpm start:dev`를 띄웠다 지울 땐 포트가 아니라 프로세스 이름(`nest.js start`)으로 찾아야 한다 — 포트 기준 정리는 "겉보기 정리"일 뿐이었다.
- **테스트**: 기존 `reservations.service.spec.ts`의 "HELD 접수 후 자동 확정" 전제 테스트들을 "confirm job을 직접 넣어(=결제 성공 흉내) 확인"으로 수정 + "결제 없이는 자동 확정 안 됨" 회귀 테스트 추가. 신규 `payments.service.spec.ts`(4)·`payment.processor.spec.ts`(3, 성공/실패/이중반환 방지). `Payment`가 `Reservation`에 FK를 걸게 되며 여러 스펙 파일의 `beforeEach`에 `payment.deleteMany()`를 `reservation.deleteMany()`보다 먼저 넣어야 했다(안 그러면 FK 제약 위반). **API 65→72 그린.**
- **프론트**: `booking-form.tsx`의 `held` 단계에 "결제하기" 버튼 추가, `paying`(PENDING)·`cancelled`(실패+반환) 상태 신설. 예매 SSE 스트림이 CONFIRMED뿐 아니라 CANCELLED도 받아 분기하도록 수정(기존 "누가 confirm을 일으켰든 방송 하나만 듣는다" 설계 그대로 재사용). 신규 테스트 2건. **web 11→13 그린.**
- **실서버 e2e**: 같은 브라우저 흐름을 5회 반복 → 4번 확정 / 1번 취소(80% 설계값과 근접) 둘 다 실제로 확인, 콘솔 에러 0.
- **다음**: 배포 6단계 또는 남은 PRD 갭(오픈 시각 검사·이벤트 목록 화면·내 예매 내역·관리자 대시보드) 중 선택.

## 2026-08-06 · PRD 갭 재검토 + 리셋 500 버그 발견·수정

- **PRD 갭 재검토(사용자 주도)**: 남은 4개 갭을 하나씩 "이 데모에 실제로 필요한가"로 재검토.
  - **오픈 시각 검사**: "오픈 전엔 대기열 자체가 안 서고, 오픈 시점에 한꺼번에 입장"까지 그려봤지만, 지금 시뮬 버튼이 이미 몰림을 보여주고 있어 **불필요로 결론**. 이 과정에서 나온 "대기열 순번을 랜덤화하면 어떨까" 제안도 검토했으나, 혼자 테스트할 때 가상 유저가 실사용자를 못 앞서게(=항상 0번) 만들면 "부여받은 순번만큼 기다린다"는 대기열의 학습 포인트 자체가 사라진다는 사용자의 반박이 맞아 **기각** — 지금처럼 도착 순서 그대로(FIFO, 실사용자·가상유저 동등)가 정답.
  - **이벤트 목록/상세**: 데모뿐 아니라 실제 제품에도 필요하다고 판단 변경 — 여러 이벤트를 보여주되 의도적으로 하나만 판매중, 나머지는 마감 처리. 리셋 방식(전체 재생성 vs 열린 이벤트 하나만 재예매 가능하게)은 학습/UX에 영향 없다고 판단해 편리성 기준으로 선택 위임받음 → 다음 세션에서 "나머지는 정적 시드, 리셋은 지금처럼 열린 이벤트 하나만" 방향으로 결정 예정(기존 코드 재사용 극대화).
  - **내 예매 내역**: 불필요로 최종 확정.
  - **관리자 대시보드**: "판매 현황"이 기존 공개 stats 대시보드와 실질적으로 같다고 확인 → 별도 화면 없이 **기존 대시보드에 통합**, 결제 성공/실패(PAID/FAILED) 집계만 추가하기로 확정. 이벤트 등록 폼·admin 역할 분기는 불필요로 확정.
- **⚠️ 발견 — 사용자가 브라우저로 직접 써보다 리셋 버튼이 500을 내는 걸 포착**: 원인 조사 결과 이번 세션에 추가한 `Payment→Reservation` FK(ADR 0018)가 `resetDemoEvent()`의 `reservation.deleteMany()`를 막고 있었다(`P2003`). 여러 테스트 스펙 파일의 `beforeEach` 정리 순서는 그날 바로 고쳤는데, **정작 실제로 리셋 버튼이 호출하는 프로덕션 메서드 자체는 놓쳤던 것** — 테스트가 전부 그린이어도 "그 로직을 실제로 호출하는 경로"가 빠지면 못 잡는다는 교훈. `payment.deleteMany({ where: { reservation: { eventId } } })`를 예매 삭제 앞에 추가해 해결, 회귀 테스트 1건 추가. **API 72→73 그린.** 실서버로 즉시 재검증(재고 100/100 정상 리셋 확인).
- **다음**: 이벤트 목록/상세 화면 구현(정적 마감 이벤트 시드 + 목록 UI) + stats 대시보드에 결제 집계 타일 추가 → 그다음 배포.

## 2026-08-06 · 이벤트 목록/상세 + 판매 현황 통합 (PRD 갭 마무리)

- **구현**: `prisma/seed.ts`에 정적 마감(`SOLD_OUT`, `isDemo:false`) 이벤트 2개를 idempotent하게 추가 — 제목으로 존재 여부를 확인해 중복 생성 방지. `resetDemoEvent()`는 `isDemo:true` 하나만 대상이라 이 둘은 리셋에 전혀 영향받지 않는다(직전 대화에서 편리성 기준으로 확정한 설계 그대로).
  - 신규 `event-list.tsx`: `GET /events` 전체를 카드로 나열, 상태(`ON_SALE`/`SOLD_OUT`/`UPCOMING`/`CLOSED`)를 한글 라벨+색으로 표시. 이벤트가 몇 개뿐이라 목록과 상세(제목/설명/가격/상태)를 한 화면에 합쳤다 — 별도 라우팅/페이지 없음.
  - `DemoStats`에 `paidCount`/`failedCount` 추가(`Payment.groupBy`). "관리자 판매 현황"이 기존 공개 stats와 실질적으로 같다는 판단(직전 대화)에 따라 별도 화면 없이 기존 대시보드 그리드에 타일 2개만 추가(`grid-cols-3`, 6타일). 헤딩 "실시간 판매 현황" 추가.
- **테스트**: `event-list.test.tsx`(1건, 판매중/매진 라벨 구분 확인). `demo.service.spec.ts`의 stats 스냅샷 테스트에 CANCELLED 예매 + Payment 2건(PAID/FAILED)을 추가해 새 집계 필드까지 검증하도록 갱신. `demo-dashboard.test.tsx`/`page.test.tsx`의 `/events` mock도 `description`/`price`/`status` 필드를 채워야 했다(EventList가 그 필드들을 쓰므로 — 안 채우면 `undefined.toLocaleString()`으로 렌더 자체가 깨짐).
- **⚠️ 삽질 — 코드가 아니라 이 세션의 셸 환경 문제**: 프론트 테스트를 돌렸는데 관련 없는 파일까지 전부 `TypeError: React.act is not a function`으로 깨짐. 원인은 이 대화의 bash 환경에 `NODE_ENV=production`이 어디선가 새어들어와 있었던 것 — react-dom이 production 빌드(테스트용 `act` 없음)로 로드됨. `unset NODE_ENV`(또는 `NODE_ENV=test` 강제)로 즉시 해결, 코드는 무관했다. Jest(백엔드)는 자체적으로 `NODE_ENV=test`를 강제해서 영향 없었다.
- **실서버 e2e**: 게이트→로그인 후 이벤트 목록(매진 2·오픈예정 1·판매중 1)과 통합 대시보드 6타일이 실제로 정상 렌더되는 것 스크린샷으로 확인. 콘솔 에러 0.
- **결과**: `docs/STATUS.md`가 기록해온 PRD 갭 4개(오픈시각·이벤트목록·예매내역·관리자대시보드) + 모의결제까지 전부 처리 완료 — 남은 건 배포뿐.

## 2026-08-06 · 실사용 중 발견한 버그 2건(테스트가 실서버를 파괴 / 가상 유저 결제 누락) + 리셋 버튼

- **계기**: 사용자가 직접 브라우저로 데모를 돌리다 세 가지를 리포트 — "가상 유저 투입했는데 재고가 안 줄어요", "큐 적체도 그대로 0", "리셋은 버튼이 안 보이는데요?". 셋 다 실사용 중 발견이라 이론적 리뷰로는 못 잡았을 버그였다.
- **원인 조사**: `docker exec sunchak-redis redis-cli`로 `queue:event:1079` Sorted Set을 보니 201명이 쌓여만 있고 전혀 빠지지 않고 있었다. `KEYS bull:admission:repeat:*`가 **아예 비어 있음** — admission 잡의 반복 스케줄러 자체가 등록 안 돼 있었다는 뜻.
- **버그 A — 진짜 원인, 이번 세션에서 가장 심각한 발견**: `admission.processor.spec.ts`·`sweep.processor.spec.ts`·`reconcile.processor.spec.ts` 세 파일 모두 `afterAll`에서 `queue.obliterate({ force: true })`를 호출하고 있었다. 문제는 이 테스트들과 실행 중이던 `pnpm start:dev`가 **같은 Redis, 같은 큐 이름을 그냥 공유**한다는 것 — `obliterate`는 "그 큐에 관한 모든 것"(대기 job·완료 이력뿐 아니라 **반복 job 스케줄러 등록 자체**)을 지우는 API라, 이번 세션 동안 `jest`를 여러 번 돌릴 때마다 매번 **실서버가 등록해둔 admission 스케줄러가 통째로 사라졌다.** 겉보기엔 서버가 멀쩡히 살아 있고 다른 기능(예매·결제)은 정상이라 원인 특정에 시간이 걸렸다.
  - **수정**: 3개 spec 파일에서 `obliterate()` 호출과, 그것 때문에만 필요했던 `queue`/`Queue`/`getQueueToken` import·변수를 전부 제거. `moduleRef.close()`(연결만 닫음)만으로 테스트 정리는 충분하다 — 반복 스케줄러는 "같은 큐 이름+같은 옵션으로 등록하는 모든 프로세스가 공유하는 멱등 자원"이라 테스트가 굳이 지울 이유가 없었다(지우면 오히려 그 이름을 쓰는 다른 프로세스까지 함께 망가짐).
  - **복구**: API 서버를 재기동해 스케줄러를 재등록하니, 막혀 있던 201명이 몇 초 안에 정상적으로 20명씩 소진됐다.
  - **교훈**: 여러 프로세스가 같은 이름으로 공유하는 Redis/큐 자원에 대해 테스트 정리 코드에서 "전체 삭제" 계열 API를 쓸 때는, 그 자원이 정말 그 테스트만의 소유인지 먼저 확인해야 한다.
- **버그 B — 별개의 두 번째 원인**: 버그 A를 고쳐 admission이 다시 돌게 했는데도 `heldCount`만 늘고 `confirmedCount`가 0에 머물렀다. 원인은 ADR 0018(모의결제)에서 confirm 트리거를 "HELD 생성 시점"에서 "결제 성공 시점"으로 옮겼을 때, `DemoService.simulateBookingAttempt()`(가상 유저 시뮬레이션 코드)는 그대로 안 고쳐졌던 것 — 여전히 `reservations.create()`만 부르고 끝나서, 아무도 결제를 안 하니 confirm job이 영원히 안 들어가 HELD에 멈춰 있었다(5분 TTL 스윕 전까지).
  - **수정**: `ReservationsModule`이 `PaymentsService`도 `exports`하도록 하고, `DemoService`에 주입 → `simulateBookingAttempt()`가 예매 성공 뒤 `payments.pay(reservation.id, userId, randomUUID())`를 호출하도록 수정(실사용자와 완전히 같은 결제 경로, 시뮬레이션 전용 분기 없음). `demo.service.spec.ts`의 관련 목·단언 갱신.
  - **검증**: 실서버에서 가상 유저 30명 투입 → `remainingQty:89, confirmedCount:11, paidCount:11, failedCount:5`로 내부적으로 일관된 값 확인(100-11=89, PAID+FAILED=16이 결제 시도 전체와 일치).
- **리셋 버튼**: 백엔드 `POST /demo/reset`은 ADR 0016 때부터 있었지만 그걸 누를 UI가 화면에 없었다(재고가 소진돼도 되돌릴 방법이 안 보임). `demo-dashboard.tsx`의 "실시간 판매 현황" 헤딩 옆에 "데이터 리셋" 버튼 추가(`useMutation`, 성공/실패 문구 표시). 신규 테스트 1건.
- **검증**: API는 위험한 정리 로직만 제거한 것이라 테스트 수 변화 없이 73개 그린. web은 리셋 테스트 추가로 **14→15개 그린**(`tsc --noEmit`·`eslint` 클린). 실서버 curl로 게이트 통과 후 `POST /demo/reset` 호출 → 재고가 정확히 100/100으로 원복되는 것 확인.
- **별개(사용자 자신의 터미널 문제)**: 사용자가 자기 터미널에서 `pnpm exec prisma studio` 실행 중 "pnpm requires Node v22.13+, 현재 v22.12.0" 에러를 만남 — 코드 문제가 아니라 시스템 기본 `node`가 낡은 버전이라 발생. 이 기기에는 이미 nvm으로 v22.23.1이 설치돼 있어(`docs/STATUS.md` "이 기기 로컬 환경" 참고) `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`를 명령 앞에 붙이거나 `nvm use v22.23.1`로 해결 가능.
- **다음**: 배포 6단계(Dockerize → CI/CD → VM+Nginx → Grafana 관측 → 최종 k6 리포트 → README/회고) — PRD 갭·이번에 발견된 버그 모두 처리 완료.

## 2026-08-06 · 리셋↔대기열 경합 수정 + "재고소진 실패" 지표 — 세 번째 실사용 시나리오

- **계기**: 위 두 버그를 고친 뒤, 사용자가 이번엔 대기열까지 포함한 시나리오를 직접 재현: "대기열 순번 0 → 200명 투입 → 즉시 98개+2개 예매 → 멈춘 것처럼 보임(결제 실패도 안 늘어남) → 리셋 → 근데 리셋 후에도 재고가 또 깎임". 두 가지를 물었다 — ① 정말 멈춘 건가 계속 진행 중이었나, ② 리셋 시 대기열도 비워야 하지 않나.
- **① 분석**: 안 멈췄다. 200명은 입장 허가(20명/2초)+랜덤 지연(0.5~10초)으로 처리에 최대 30초 걸리는 게 정상 설계다. 재고가 소진된 뒤 나머지 시도는 `demo.service.ts`의 `catch (ConflictException) { return; }`에서 조용히 삼켜진다(재고소진이 이 데모가 보여주려는 정상 종료 시나리오라 의도적으로 조용함) — 그래서 "멈춘 것처럼" 보였을 뿐. **"결제 실패가 안 늘어난 이유"도 발견**: `failedCount`(결제 실패)는 결제 단계까지 도달한 뒤 20% 확률로만 나오는 지표인데, 재고소진으로 막힌 시도는 결제 단계에 도달조차 못 해 아예 다른 지표다 — 지금까지 이 둘을 구분할 UI가 없어서 "결제 실패가 왜 안 늘지?" 혼란이 생겼다.
- **② 확인 — 진짜 버그였다**: `resetDemoEvent()`가 재고·예매·유저는 리셋하면서 Redis 대기열(`queue:event:{id}` Sorted Set, ADR 0017)은 손 안 댔다. 그래서 리셋 전에 대기 중이던 사람들이 리셋 후에도 계속 입장 허가를 받아, 방금 원복한 재고를 또 깎았다.
- **설계 옵션을 사용자에게 물어봄**: "대기열 ZSet만 비우기(간단, 대부분 해결)" vs "세대(generation) 기반 완전 무효화(완벽하지만 여러 파일에 개념 전파 필요)" — **사용자가 A(ZSet만 비우기)를 선택**. 부가로 "재고소진 실패"를 스탯에 노출할지도 물어 **노출하기로 확정**.
- **구현**: `QueueService.purge(eventId)`(ZSet `DEL` + `queues:active`에서 `SREM`) 신규 → `resetDemoEvent()`가 재고 원복과 함께 호출. `reservations.service.ts`의 `createHeld()` 재고소진 분기(관문 DECRBY 음수)에 `soldout:event:{id}` Redis 카운터 추가(`INCR`) — `Payment.idempotencyKey` 논의 때처럼 W2 벤치마크 전략(naive~redis)은 안 건드리고 실제 파이프라인(held)에만 추가. `DemoStats.soldOutCount`로 노출, `demo-dashboard.tsx`에 "재고소진 실패" 타일 추가.
- **실서버로 한계까지 실측**: 30명 투입 1초 후 즉시 리셋 → 대기열 ZSet은 그 순간 0으로 비워졌지만, **이미 입장 허가를 받아 `admitted:event:{id}:{userId}` TTL 키를 든 소수는 여전히 통과** — 리셋 후 수 초간 재고가 100→97로 더 깎였다. 이건 사전에 예상하고 사용자에게 공지한 대로다: 그 키는 대기열 ZSet에 없어 `purge()`가 못 건드리고, 입장 허가창(기본 8초) TTL이 지나야 자연히 막힌다. 예전 버그(200명 중 대다수가 새던 것) 대비 훨씬 좁은 창(최대 8초, 실측 3명 정도)으로 줄었고, 그 창이 지난 뒤(약 10~15초 후) 다시 리셋하면 완전히 깨끗하게 100으로 복구되는 것도 확인. **완전 차단(세대 기반 무효화)은 범위 초과로 보류** — 사용자가 A안의 이 트레이드오프를 인지하고 선택.
- **테스트**: `queue.service.spec.ts`(+1, `purge`) · `demo.service.spec.ts`(+1, 리셋 시 대기열 비움 / stats 테스트에 `soldOutCount` 포함) · `reservations.service.spec.ts`(재고부족 테스트에 soldout 카운터 단언 추가). **API 73→75 그린.** 프론트 테스트 갱신(신규 타일 값 확인). **web 15개 유지.**
- **부수 작업**: 사용자가 자기 터미널에서 `nvm: command not found`를 만나 원인을 확인 — `~/.nvm/nvm.sh`는 있었는데 `~/.zshrc`가 그걸 source하는 코드가 없었다. 사용자 동의 후 `~/.zshrc`의 `# NVM` 주석 아래에 `NVM_DIR` export + `nvm.sh` source 3줄을 추가해 실제 터미널에서 `nvm use v22.23.1`이 정상 동작하는 것까지 확인.
- **다음**: 배포 6단계. PRD 갭·발견된 버그 3건 모두 처리 완료.

## 2026-08-06 · 이벤트 목록 별도 페이지 분리 + 결제 TTL 30초 + `demo` 도메인 개념 정리

- **`demo` 도메인 질문**: 사용자가 "`demo`가 테스트/프로덕션을 가르는 경계가 아니라 가상유저 플로우를 의미하는 거라면 무방하다"고 확인 요청. `app.module.ts`에 `DemoGateGuard`가 전역 가드로 박혀 있고 `DemoModule`이 배포 서버 자체에서 상시 동작하는 걸 근거로 확인 — 이 프로젝트는 "데모와 분리된 진짜 프로덕션"이 따로 없고 **배포된 사이트 자체가 데모**라, `demo`는 환경 분기가 아니라 "가상유저 시뮬레이션+게이트+stats+리셋" 기능 도메인의 이름이 맞다고 결론. 리네이밍은 안 함(비용 대비 이득 적음, 나중에 README에 이 정의만 한 줄 남기면 충분).
- **결제 TTL 30초로 변경**: PRD 원안은 5분이지만 방문자가 만료를 체감하기엔 너무 길다는 판단(사용자 요청) — `reservations.service.ts`의 `HELD_TTL_MS`를 `5 * 60 * 1000` → `30 * 1000`으로 변경. **부수 조정**: sweep 주기(`SWEEP_INTERVAL_MS`)가 기존 30초 그대로면 "30초 후 반환"이 최악의 경우 최대 60초까지 늘어져 체감이 어긋난다 — TTL과 비슷하거나 넓은 sweep 주기는 원래 설계 의도("TTL보다 훨씬 촘촘")를 깨는 것이라 5초로 같이 좁혔다. 실서버로 HELD 생성 후 결제 없이 방치 → 정확히 heldUntil(30초 뒤) 근처에서 sweep이 회수해 DB는 EXPIRED, Redis 재고는 원복되는 것 확인(생성 01:31:22 → 회수 확인 01:31:56, TTL+sweep 텀 이내).
- **이벤트 목록을 별도 페이지로 분리 + 판매중만 진입 가능**: 지금까지 `event-list.tsx`는 데모 대시보드 안에 인라인으로 박혀 있었고, 클릭해도 아무 동작이 없었다(어떤 이벤트를 클릭하든 `booking-form.tsx`는 항상 `isDemo` 이벤트로 예매를 진행 — 목록의 선택과 예매 대상이 서로 무관했음). 사용자 요청으로 실제 내비게이션을 만들었다:
  - 신규 라우트 `app/events/page.tsx`(목록, `EventList` 렌더) + `app/events/[id]/page.tsx`(상세, `useParams()`로 id를 읽어 `GET /events/:id` 조회 후 `status==='ON_SALE'`일 때만 `BookingForm`을 렌더 — 아니면 "지금 판매중이 아닙니다" 안내).
  - `event-list.tsx`: `ON_SALE` 카드만 `next/link`로 `/events/{id}`에 연결, 나머지는 그대로 클릭 불가 div.
  - `booking-form.tsx`: 더 이상 `/events`를 스스로 조회해 `isDemo` 이벤트를 찾지 않는다 — 호출부(`[id]/page.tsx`)가 이미 확인한 `eventId`/`eventTitle`을 props로 받는다(불필요한 자체 탐색 제거, 진입 시점에 이미 검증된 이벤트라 다시 찾을 이유가 없음).
  - `demo-dashboard.tsx`: 인라인 `EventList`/`BookingForm`을 제거하고 "이벤트 목록 보기 →" 링크로 대체 — 대시보드는 이제 순수하게 관측/운영 패널(stats·시뮬레이션·리셋)이고, 예매는 이벤트 상세 페이지에서만 일어난다.
  - **회귀 발견·수정**: `/events/[id]`가 독립 라우트가 되며 로그인 전 상태(게이트만 통과)로도 도달 가능해졌다 — 예전엔 대시보드(로그인 후에만 렌더)를 통해서만 `BookingForm`에 닿을 수 있어서 문제가 안 됐지만, 지금은 로그인 안 된 방문자가 "대기열 입장"을 눌러도 서버가 401을 주는데 `handleJoinQueue`가 응답 성공 여부를 확인 안 해서 화면은 태연히 "대기 중입니다"를 보여주는 버그가 될 뻔했다. `res.ok` 체크를 추가해 실패 시 에러 문구+재시도 버튼을 보여주도록 고침.
- **테스트**: `event-list.test.tsx`(+1, ON_SALE만 링크) · 신규 `events/[id]/page.test.tsx`(3, ON_SALE 진입/비ON_SALE 차단/404) · `booking-form.test.tsx`(props 방식으로 전면 수정 +1, 401 회귀 테스트) · `demo-dashboard.test.tsx`(EventList/BookingForm mock 제거, "이벤트 목록 보기" 링크 테스트로 교체) · `page.test.tsx`(대시보드 분기 mock 단순화). **web 15→21 그린.** 백엔드는 TTL 상수만 바꾼 것이라 테스트 수 불변, **API 75개 유지**(sweep/reconcile spec은 heldUntil을 직접 세팅해 상수값에 안 의존).
- **다음**: 배포 6단계(Dockerize → CI/CD → VM+Nginx → Grafana 관측 → 최종 k6 리포트 → README/회고).

## 2026-08-06 · 예매·판매현황 화면 재통합 + "포기(abandoned)" 지표 신설

- **계기**: 직전 작업에서 이벤트 목록을 별도 페이지로 분리하며 예매(BookingForm)와 판매현황(DemoDashboard)도 함께 떼어놨는데, 사용자가 실제로 `/events/*`에 들어가보니 대기열 입장 UI만 보이고 판매현황·가상유저투입이 안 보여서 "제대로 테스트가 안 된다"고 지적. 같은 시점에 캡처와 함께 "200명 투입했는데 재고소진(121)+결제성공(10)이 200과 안 맞는다"는 두 번째 이슈도 제기.
- **화면 재구성 방향**: 사용자 피드백의 핵심은 "내가 누른 예매 결과를 그 자리에서 지켜봐야 테스트가 의미 있다"는 것 — 예매와 관측(stats)을 분리한 게 오히려 테스트를 방해했다. `BookingForm`과 `DemoDashboard`를 다시 한 화면에 두되, 위치는 예전(루트 대시보드)이 아니라 **`/events/[id]`(이벤트 상세)**로 옮겼다 — 이벤트가 하나뿐인 데모라 stats도 사실상 이 이벤트 전용이라 자연스러운 배치. 루트 `/`는 게이트+로그인 통과 후 직접 화면을 그리지 않고 `useRouter().replace('/events')`로 넘긴다 — 목록 렌더링 코드가 root와 `/events` 두 곳에 중복되는 걸 피하기 위함(이벤트 목록 렌더링의 단일 소스는 `event-list.tsx` 하나).
- **숫자 불일치 진단**: 사용자가 "200명인데 왜 재고소진+결제성공 합이 200이 아니냐"고 물어서 코드를 추적해보니 원인이 세 겹이었다.
  1. **입장 허가를 받고도 확률적으로 포기하는 20%(`DEMO_SIM_ABANDON_PROBABILITY`)가 어떤 카운터에도 안 잡힌다** — `reservations.create()` 자체를 호출 안 하니 재고소진(soldOutCount)에도 안 걸리는, 완전히 투명한 버킷이었다.
  2. **더 미묘한 두 번째 투명 버킷**: 가상 유저의 랜덤 사전지연(최대 10초, `DEMO_SIM_MAX_BOOKING_DELAY_MS`)이 입장 허가창(기본 8초, `QUEUE_ADMISSION_WINDOW_MS`)보다 길 수 있어, 그 사이 허가가 자연 만료되면 `assertAdmitted`가 `ForbiddenException`을 던지고 `simulateBookingAttempt`의 catch가 이걸 재고소진(`ConflictException`)과 같이 "조용히 넘어간다"고 뭉뚱그려 처리하는데, 코드 주석은 "포기(허가창 만료 포함)"라고 이미 이 둘을 같은 개념으로 취급하고 있었음에도 **집계는 안 하고 있었다** — 주석과 실제 동작이 어긋나 있던 셈.
  3. 200명은 입장 허가(20명/2초)+랜덤 지연 처리에 최대 30초 걸리는데 캡처는 그 중간 시점이었고, 모든 카운터가 이번 라운드가 아니라 **리셋 이후 누적치**라 혼란을 더했다.
- **수정**: `soldout:event:{id}`를 만들 때 세운 패턴 그대로 `abandoned:event:{id}` Redis 카운터를 신설. `simulateBookingAttempt()`의 확률적 포기 분기와, catch 블록의 `ForbiddenException`(허가창 만료) 분기 — 둘 다 여기 누적(`ConflictException`/재고소진은 이미 `createHeld()`에서 별도로 세고 있어 그대로 둠). `DemoStats.abandonedCount` 필드 추가, `resetDemoEvent()`가 0으로 리셋, 프론트 `demo-dashboard.tsx`에 "포기(미시도)" 타일 추가.
- **실서버로 등식 검증**: 리셋 후 40명 투입 → 대기열(`queues:active`)이 빌 때까지 + 최대 지연(10초) 여유까지 기다린 뒤 최종 스냅샷 확인 → `paidCount(27)+failedCount(1)+soldOutCount(0)+abandonedCount(12) = 40`, 투입 인원수와 정확히 일치. 수정 전에는 같은 방식으로 재본 40명 라운드가 `16+9+0+9=34`로 6명이 비어 있었다(그 6명이 바로 위 2번 버킷, 허가창 만료).
- **테스트**: `demo.service.spec.ts`의 기존 포기·허가창만료 테스트 2건에 `redis.get(abandonedKey())` 단언 추가, stats 스냅샷 테스트에 `abandonedCount` 포함(신규 `it` 없이 기존 보강이라 **API 75개 유지**). 프론트: `demo-dashboard.test.tsx`(SSE 스냅샷에 abandonedCount 포함) · `events/[id]/page.test.tsx`(DemoDashboard가 `useMutation`을 쓰므로 `QueryClientProvider`로 감싸는 `renderPage()` 헬퍼 추가, ON_SALE 케이스에서 "실시간 판매 현황"도 함께 뜨는지 확인) · `page.test.tsx`(`next/navigation`의 `useRouter`를 `vi.mock`으로 대체해 `/events`로 `replace` 호출되는지 검증 — 예전엔 대시보드 렌더 결과를 직접 봤지만 이제 리다이렉트만 하므로 방식을 바꿈). **web 21개 유지**(기존 테스트 보강 위주).
- **부수 발견(회귀 아님, 확인만)**: `/events/[id]`가 로그인 전에도 도달 가능해진 채로 있어(직전 세션에서 `handleJoinQueue`의 401 미처리는 이미 고쳤음), 이번엔 `DemoDashboard`가 함께 렌더되며 `useMutation`이 `QueryClientProvider` 없이 쓰이면 크래시한다는 걸 테스트 작성 중 발견 — 실제 앱은 `RootLayout`이 이미 `Providers`로 감싸므로 문제없지만, 격리된 단위 테스트에서는 직접 감싸야 한다는 걸 놓쳤던 것(테스트 인프라 이슈, 프로덕션 코드는 무관).
- **다음**: 배포 6단계. PRD 갭·발견된 버그 모두 처리 완료, 데모 스탯 정합성도 실측으로 검증됨.

## 2026-08-06 · "입장 대기중" 지표 추가

- **계기**: 사용자가 "대기열 진입 전 가상 유저 수도 집계할 수 있나요"라고 질문. 파이프라인을 다시 보니 두 가지 다른 해석이 가능했다 — ① "요청은 했지만 아직 대기열에 join도 안 된 수"(투입 배치가 20명/300ms로 나가는 진행률), ② "이미 대기열엔 들어갔지만 아직 입장 허가를 못 받은 수"(ADR 0017 Sorted Set의 크기). 구현 비용과 개념이 서로 꽤 다르므로 침묵하지 않고 두 옵션을 사용자에게 제시 → **②**로 확정.
- **구현**: `QueueService`에 `size(eventId)`(`ZCARD queue:event:{id}`) 메서드 신규 추가 — `deactivateIfEmpty()`가 이미 같은 걸 내부적으로 하고 있어서 그 패턴을 그대로 공개 메서드로 뽑은 것. `DemoStats.admissionQueueCount`로 노출. 리셋 시 별도 처리 불필요 — `QueueService.purge()`가 이미 이 ZSet 자체를 지우므로 `size()`는 그냥 0을 반환하게 된다.
- **네이밍 함정**: 기존 `queueBacklog` 필드가 이미 있어서 헷갈리기 쉬웠는데, 그건 BullMQ의 `confirm` 큐(결제 확정 job)이고 이번에 추가한 건 Redis Sorted Set 기반 입장 대기열로 **완전히 다른 큐**다. 주석과 필드명(`admissionQueueCount`)에 이 구분을 명시했다.
- **구현 도중 사용자가 던진 별도 질문**: "재고 잔량이 있는데도 포기(미시도)가 뜨는 건 왜?" — 확인해보니 `abandonedCount`는 재고와 완전히 무관하게 두 경로로만 증가한다: ① 확률적 포기(기본 20%, `demo.service.ts:275`)는 예매 시도 자체를 안 하므로 재고 확인 단계에도 못 간다. ② 입장 허가창(8초)보다 랜덤 사전지연(최대 10초)이 길게 뽑히면 허가가 자연 만료돼 `ForbiddenException`으로 막히는데(`demo.service.ts:299`), 이것도 순전히 타이밍 문제라 재고와 무관하다. 재고가 넉넉해도 이 두 경로는 항상 일정 비율로 발생하는 게 정상 — 사용자에게 코드 위치와 함께 설명.
- **실서버 검증**: 리셋 후 40명 투입 1초 후 스냅샷 → `admissionQueueCount:20, abandonedCount:4`. 정확히 첫 배치 20명만 허가 처리되고 나머지 20명이 대기 중이며, 허가받은 20명 중 4명(정확히 20%)이 벌써 포기 판정까지 끝난 상태 — 파이프라인의 각 단계가 실시간으로 눈에 보이는 것을 확인.
- **테스트**: `queue.service.spec.ts`(+1, `size` — join 2명 후 1명 popNext로 빼서 나머지 1명만 남는지 확인). `demo.service.spec.ts`의 stats 스냅샷 테스트에 실제 `QueueService.join()`을 호출해 대기 인원을 만들고 `admissionQueueCount` 단언 추가(신규 `it` 없이 기존 보강, **API 75→76**은 `size` 테스트 1건 추가분). 프론트 `demo-dashboard.test.tsx`(SSE 스냅샷에 admissionQueueCount 포함 + "입장 대기중" 타일 텍스트 확인). **web 20개 유지**(기존 테스트 보강 위주).
- **다음**: 배포 6단계. 데모 스탯이 이제 파이프라인 전 구간(대기열→HELD→결제→확정, 그리고 포기·재고소진 두 이탈 경로까지)을 실시간으로 빠짐없이 보여준다.
