# 현재 상태 (기기 간 세션 인수인계용)

> **이 파일은 "지금 어디까지 됐고 다음은 뭔가"를 담는 항상 최신인 스냅샷 1장이다.**
> 세션 공유가 안 되는 두 기기(회사/집)가 이 파일로 싱크를 맞춘다.
> - **세션 시작 시**: 이 파일을 가장 먼저 읽고 "다음 할 일"부터 이어간다.
> - **세션 끝 / 커밋 전**: 이 파일을 **덮어써서** 최신 상태로 갱신한다. (시간순 이력·삽질은 `DEVLOG.md`, 결정 근거는 `decisions/`)

**마지막 업데이트:** 2026-07-16 · 집 기기 (W2 — k6 4전략 비교 완료, 다음은 Redis)

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
- **k6 4전략 부하 비교(§8)**: VU30·15s·재고20만·hot row. **atomic이 승자**(RPS 2030·정확), naive는 lost update 3.5만, optimistic은 재시도 thrashing으로 8,503 실패, pessimistic은 정확하나 느림. 문서: `docs/perf/2026-07-16-w2-lock-comparison.md`. 스크립트: `apps/api/test/load/`.

## 🔨 진행 중 / 막힌 것
- (없음). 장시간 테스트 시 JWT(1h) 만료 주의 → 재로그인으로 토큰 갱신.

## ▶️ 다음 할 일 (이 순서로)
1. ✅ ~~락 3종~~ / ✅ ~~4전략 리팩터~~ / ✅ ~~k6 4전략 비교~~ — 완료.
2. **Redis 원자 차감** — 재고 카운터를 Redis(`DECR` 또는 Lua)에서 원자적으로 깎는 5번째 전략 추가 → 동일 k6 프리셋으로 DB atomic과 처리량 비교. (Redis는 로컬, docker-compose에 이미 정의됨.)
3. (선택) 회차 평균·VU 스윕(10/50/100)으로 벤치 정밀화.

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
3. **로컬 PG 기동**: `cd infra && docker compose up -d postgres` → `cd apps/api && pnpm exec prisma migrate deploy`.
   - ⚠️ `apps/api/.env`의 `DATABASE_URL`이 로컬(`localhost:5432`)인지 확인. W2는 로컬, 공유 dev(Neon)로 돌아갈 땐 주석의 Neon URL로 교체.
4. 서버: `pnpm start:dev` (W2는 infisical 불필요 — 로컬 .env가 JWT_SECRET 등 다 제공).
5. 더 깊은 맥락: `docs/DEVLOG.md` → `docs/decisions/` → `git log`.
