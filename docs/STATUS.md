# 현재 상태 (기기 간 세션 인수인계용)

> **이 파일은 "지금 어디까지 됐고 다음은 뭔가"를 담는 항상 최신인 스냅샷 1장이다.**
> 세션 공유가 안 되는 두 기기(회사/집)가 이 파일로 싱크를 맞춘다.
> - **세션 시작 시**: 이 파일을 가장 먼저 읽고 "다음 할 일"부터 이어간다.
> - **세션 끝 / 커밋 전**: 이 파일을 **덮어써서** 최신 상태로 갱신한다. (시간순 이력·삽질은 `DEVLOG.md`, 결정 근거는 `decisions/`)

**마지막 업데이트:** 2026-07-14 · 회사 기기

---

## ✅ 완료
- **W1 스키마**: `apps/api/prisma/schema.prisma` — User/Event/Inventory/Reservation/Payment + enum 4종 (→ ADR 0009). *단, 아직 실제 마이그레이션은 미실행.*
- **W1 서버 뼈대**: NestJS 스캐폴딩 — ConfigModule(전역) + `@Global` PrismaService + `GET /health` (PORT 3001).
- **인프라 결정**: Neon 클라우드 Postgres 프로젝트 `sunchak` 생성(싱가포르, PG18) (→ ADR 0010). 비밀값은 Infisical로 관리 (→ ADR 0011). 패키지 매니저 pnpm(corepack) (→ ADR 0012).
- **Infisical 연결**: `apps/api`에 `infisical init` 완료(`.infisical.json`). Development 환경에 `DATABASE_URL`/`PORT`/`REDIS_URL` 저장. CLI는 `npm i -g @infisical/cli`로 설치.
- **pnpm 전환 완료**: corepack로 pnpm@11 고정, `pnpm-lock.yaml`, `pnpm-workspace.yaml`의 `allowBuilds`로 prisma 빌드 허용.
- **첫 마이그레이션 적용**: `20260714002709_init` — Neon에 테이블 5 + enum 4 + 인덱스/FK 생성.
- **서버 기동 확인**: `/health` 200 응답 확인 완료.
- **회원가입**: `POST /auth/signup` — DTO 검증 + argon2 해싱 + 유저 생성, 비번 해시 응답 제외 (→ ADR 0013). 전역 ValidationPipe.
- **로그인**: `POST /auth/login` — `argon2.verify`로 비번 대조 후 JWT 발급(@nestjs/jwt, `JwtModule.registerAsync`로 JWT_SECRET/EXPIRES_IN 주입). 실패는 401 동일 메시지. tsc 통과.

## 🔨 진행 중 / 막힌 것
- (없음)

## ▶️ 다음 할 일 (이 순서로)
1. **보호 가드**: passport-jwt Strategy + `JwtAuthGuard` → `GET /auth/me`로 "토큰 있어야 접근" 검증.
2. **이벤트 CRUD**: 관리자(role=ADMIN)만 생성. 서비스 테스트(Jest, 한글 describe/it).

> Infisical Development에 `JWT_SECRET`, `JWT_EXPIRES_IN`(=1h) 추가 완료.

## 🖥️ 다른 기기에서 이어받는 법
1. `git pull`
2. 이 파일(`docs/STATUS.md`) 읽기 → "다음 할 일"부터 시작.
3. 비밀값이 필요하면 `infisical run --env=dev -- <명령>`으로 주입 (평문 `.env` 나르지 않음). CLI 없으면 `npm i -g @infisical/cli` 후 `infisical login`.
4. 더 깊은 맥락이 필요하면 `docs/DEVLOG.md`(이력) → `docs/decisions/`(결정) → `git log` 순으로 확인.
