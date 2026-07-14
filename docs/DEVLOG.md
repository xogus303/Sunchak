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
