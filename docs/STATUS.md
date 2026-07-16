# 현재 상태 (기기 간 세션 인수인계용)

> **이 파일은 "지금 어디까지 됐고 다음은 뭔가"를 담는 항상 최신인 스냅샷 1장이다.**
> 세션 공유가 안 되는 두 기기(회사/집)가 이 파일로 싱크를 맞춘다.
> - **세션 시작 시**: 이 파일을 가장 먼저 읽고 "다음 할 일"부터 이어간다.
> - **세션 끝 / 커밋 전**: 이 파일을 **덮어써서** 최신 상태로 갱신한다. (시간순 이력·삽질은 `DEVLOG.md`, 결정 근거는 `decisions/`)

**마지막 업데이트:** 2026-07-16 · 집 기기 (W2 — 비관적 락으로 초과판매 차단 완료)

---

## ✅ 완료
- **W1 전체**: 스키마·마이그레이션·인증(회원가입/로그인/보호가드)·이벤트 CRUD·단위 테스트 8개. (자세한 건 이전 이력 참고 — DEVLOG)
- **W2 로컬 실험 환경**: 로컬 Postgres(docker-compose, :5432) 기동 + `apps/api/.env`의 `DATABASE_URL`만 로컬로 교체(Neon URL은 주석 보존) + `prisma migrate deploy` 반영. 서버는 `pnpm start:dev`(infisical 없이, 로컬 .env 자동 로드).
- **순진한 예매 API**: `reservations` 모듈 — `POST /events/:eventId/reservations`(JWT 필요). ①읽기 →②확인 →③절대값 덮어쓰기 차감 →④예매기록. 단일 요청 재고 5→4 정상 확인.
- **초과판매(oversell) 재현**: 재고 1개에 동시 30개 → 전부 201, **예매 30건/초과판매 29건**. 재고는 lost update로 `-29`가 아닌 `0`(더 은밀). 재현 스크립트는 scratchpad, 지연은 ②③사이 `setTimeout(50ms)`(학습용).
- **비관적 락(락 3종 중 1번)**: `$transaction` + `SELECT … FOR UPDATE`로 재고 행을 잠금. 동일 조건(재고 1·동시 30)에서 **1건 성공·29건 409·초과판매 0**으로 방어 확인.

## 🔨 진행 중 / 막힌 것
- (없음). 참고: `reservations.service.ts`의 `setTimeout(50ms)`는 재현용 지연 — 락 3종 비교 끝나면 제거 예정.

## ▶️ 다음 할 일 (이 순서로)
1. ✅ ~~비관적 락~~ — 완료(1건만 성공 검증).
2. **낙관적 락(optimistic lock)** — `version` 컬럼으로 `UPDATE … WHERE id=? AND version=?` 후 결과 0건이면 재시도. 비관 vs 낙관 비교(락 대기 없음 vs 재시도 비용).
3. **DB 원자연산** — `remainingQty >= quantity` 조건부 단일 UPDATE(`{ decrement }`)로 가장 단순한 해법 비교.
4. **Redis** 기반 접근 + **k6** 부하테스트로 세 방식 처리량 before/after 문서화(§8).

## 🖥️ 다른 기기에서 이어받는 법 (W2는 로컬 DB!)
1. `git pull`
2. 이 파일 읽기 → "다음 할 일"부터.
3. **로컬 PG 기동**: `cd infra && docker compose up -d postgres` → `cd apps/api && pnpm exec prisma migrate deploy`.
   - ⚠️ `apps/api/.env`의 `DATABASE_URL`이 로컬(`localhost:5432`)인지 확인. W2는 로컬, 공유 dev(Neon)로 돌아갈 땐 주석의 Neon URL로 교체.
4. 서버: `pnpm start:dev` (W2는 infisical 불필요 — 로컬 .env가 JWT_SECRET 등 다 제공).
5. 더 깊은 맥락: `docs/DEVLOG.md` → `docs/decisions/` → `git log`.
