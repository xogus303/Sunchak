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
- **인프라 결정**: Neon 클라우드 Postgres 프로젝트 `sunchak` 생성(싱가포르, PG18) (→ ADR 0010). 비밀값은 Infisical로 관리 (→ ADR 0011).

## 🔨 진행 중 / 막힌 것
- (없음)

## ▶️ 다음 할 일 (이 순서로)
1. **첫 마이그레이션** (로컬에서 실행):
   `cd apps/api && infisical run -- npx prisma migrate dev --name init`
   → 검증: Neon 콘솔에 테이블 5종 + enum 생성 확인, `prisma migrate status` 클린.
2. **서버 기동 확인**: `infisical run -- npm run start:dev` → `curl localhost:3001/health` 200 확인.
3. **JWT 인증** (argon2 해싱) + **이벤트 CRUD** 엔드포인트 + 서비스 테스트(Jest, 한글 describe/it).

## 🖥️ 다른 기기에서 이어받는 법
1. `git pull`
2. 이 파일(`docs/STATUS.md`) 읽기 → "다음 할 일"부터 시작.
3. 비밀값이 필요하면 `infisical run -- <명령>`으로 주입 (평문 `.env` 나르지 않음).
4. 더 깊은 맥락이 필요하면 `docs/DEVLOG.md`(이력) → `docs/decisions/`(결정) → `git log` 순으로 확인.
