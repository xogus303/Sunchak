# Sunchak

소규모 공연·클래스 **선착순 예매 서비스**. 5년차 프론트엔드 개발자의 풀스택·인프라 전환 학습 + 포트폴리오용 사이드 프로젝트.

순간 대량 트래픽 상황에서 **초과 판매 0**을 보장하는 동시성 제어, 실시간 대기열(SSE), 비동기 결제(큐), 그리고 그 전체를 지켜보는 관측(Prometheus+Grafana)까지 다룬다.

## 라이브 데모

| | 주소 |
|---|---|
| 프론트엔드 | https://app.15.164.234.208.sslip.io |
| 백엔드 API | https://api.15.164.234.208.sslip.io |
| 관측 대시보드(Grafana) | https://grafana.15.164.234.208.sslip.io |

도메인을 따로 구매하지 않고 무료 매직 도메인(`sslip.io`, 서브도메인 문자열에 박힌 IP를 그대로 풀어주는 DNS)으로 HTTPS까지 확보했다 — 이유는 [ADR 0019](docs/decisions/0019-deployment-infra.md).

## 무엇을 다루는가

| 문제 | 접근 |
|---|---|
| 순간 대량 요청이 재고 하나를 동시에 건드림(초과판매) | 순진한 구현 → 초과판매 재현 → 락 3종(비관/낙관/DB원자) → Redis 인메모리 원자 차감까지 5가지를 실측 비교 |
| 재고는 남았는데 다 같이 몰리면 다운스트림이 못 버팀 | 관문(Redis) 앞에 **입장 대기열**(FIFO, 배치 허가)을 둬 처리 속도 자체를 늦춤 |
| 결제는 응답을 오래 기다리게 하면 안 됨 | HELD(임시 확보) → 큐(BullMQ)로 비동기 확정, 클라이언트는 SSE로 실시간 구독 |
| "지금 서버가 괜찮은지" 눈으로 봐야 함 | Prometheus + Grafana로 요청률·p95·에러율·큐 적체를 실시간 대시보드화 |

## 스택

- **Frontend**: Next.js(App Router) + TypeScript + TanStack Query + Tailwind
- **Backend**: NestJS + TypeScript + Prisma
- **Data**: PostgreSQL(Neon, 서버리스) + Redis
- **Queue**: BullMQ(입장 허가·확정·결제·재고 재구성 4개 큐)
- **Realtime**: SSE(대기열 순번, 예매 확정)
- **Infra**: Docker/docker-compose, AWS EC2 VM + Nginx(리버스 프록시) + Let's Encrypt, GitHub Actions(CI/CD)
- **관측**: Prometheus + Grafana + node-exporter
- **Load test**: k6

## 예매 파이프라인

```
게이트(비번) → Google 로그인 → 대기열 입장(FIFO)
  → 입장 허가(2초마다 20명씩 배치)
  → HELD 예매(Redis 관문 통과 + DB 임시 확보)
  → 결제 접수(비동기 큐, 80%/20% 성공/실패)
  → 확정(BullMQ 워커) → SSE로 클라이언트에 실시간 반영
```

세부 설계 근거는 [`docs/decisions/`](docs/decisions/)의 ADR 0014(락 비교)·0015(HELD+큐 파이프라인)·0017(대기열)·0018(모의 결제) 참고.

## 폴더 구조

```
sunchak/
├── apps/
│   ├── api/          NestJS 백엔드 — 인증·이벤트·예매·대기열·결제·관측 지표
│   └── web/           Next.js 프론트엔드 — 게이트/로그인/이벤트/예매/판매현황 대시보드
├── infra/
│   ├── docker-compose.yml        로컬 개발용(postgres+redis)
│   ├── docker-compose.prod.yml   VM 배포용(api/web/redis + node-exporter/prometheus/grafana)
│   ├── nginx/                    서브도메인별 리버스 프록시 설정
│   ├── prometheus/                스크레이프 설정
│   └── grafana/provisioning/     데이터소스 자동 등록
├── docs/
│   ├── 01_기술_로드맵.md / 02_서비스_기획안.md   기획 문서
│   ├── DEVLOG.md                 시간순 개발 이력(결정·삽질·배운 점)
│   ├── STATUS.md                 현재 상태 스냅샷(항상 최신으로 덮어씀)
│   ├── perf/                     k6 부하 테스트 비교 리포트
│   └── decisions/                의사결정 기록(ADR) — 모든 선택의 대안·근거
└── .github/workflows/            ci.yml(테스트 자동화) / cd.yml(이미지 빌드+배포)
```

## 로컬 실행

```bash
pnpm install                 # 루트에서 한 번(pnpm 워크스페이스)
pnpm docker:up                # 로컬 postgres(5432) + redis(6379)
cd apps/api && pnpm exec prisma migrate deploy && pnpm exec prisma generate
pnpm dev:api                  # http://localhost:3001
pnpm dev:web                  # http://localhost:3000
```

테스트: `cd apps/api && pnpm exec jest` (87개) / `cd apps/web && pnpm test` (Vitest, 40개).

## 진행 상황

- [x] W1 — 인증(JWT/Google SSO) + 이벤트 CRUD + DB 설계
- [x] W2 — 동시성 실험(순진한 구현 → 초과판매 재현 → 락 3종 + Redis) + k6 비교
- [x] W3 — 대기열(SSE) + HELD + 비동기 확정(BullMQ)
- [x] W4 — 공개 데모(게이트·부하 시뮬레이션·실시간 대시보드) + 프론트엔드
- [x] 배포 — Dockerize → CI/CD → VM+Nginx+HTTPS → 관측(Prometheus+Grafana) → 최종 k6 부하 리포트
- [ ] README + 회고 정리 ← 지금 여기
- [ ] ADR·설계 문서 최신화(구현과 어긋난 부분 `Superseded` 표시)

## 성능

- **동시성 5전략 비교**(재고 1, 동시 30 요청, hot row 극한 경합): naive는 초과판매 29건(lost update), atomic은 정확 + 준수한 속도, **Redis 원자 차감이 atomic보다 처리량 4.6배·p95 최저**로 완승. → [`docs/perf/2026-07-16-w2-lock-comparison.md`](docs/perf/2026-07-16-w2-lock-comparison.md)
- **전체 파이프라인 부하**(대기열→HELD→결제, 로컬 150 VU / 배포 VM 8 VU): 체크 성공률 100%, VM 개별 요청 p99도 1초 미만. 로컬↔VM 격차(약 6~8배)의 원인(Neon 네트워크 홉·실제 인터넷 왕복·t3.micro 사양)을 실측으로 설명. → [`docs/perf/2026-08-21-full-pipeline-load.md`](docs/perf/2026-08-21-full-pipeline-load.md)

## 회고 — 기억할 만한 삽질들

전체 이력은 [`docs/DEVLOG.md`](docs/DEVLOG.md)에 시간순으로 남아 있다. 그중 "설계·판단"을 배운 대표 사례만.

- **재고가 `-29`가 아니라 `0`으로 보이는 게 더 위험했다.** 순진한 구현(읽기→계산→절대값 쓰기)에 재고 1개·동시 30요청을 던졌더니 30건 전부 성공(초과판매 29건)인데, 재고 카운터는 음수가 아니라 **0**이었다. 30번의 쓰기가 서로를 덮어써(lost update) 정상처럼 보이는 값을 남긴 것 — 계기판이 정상이라고 거짓말하는 버그가 왜 더 무서운지 체감한 사례.
- **DB 조건부 단일 UPDATE(atomic)보다 Redis 원자 차감이 4.6배 빨랐다.** 둘 다 "같은 카운터를 직렬화한다"는 점은 같은데, Postgres의 행 락·MVCC·WAL 비용과 Redis RAM 정수 감산의 비용 차이가 그대로 처리량 격차로 드러났다. 병목은 "DB가 느려서"가 아니라 **단일 재고 행 쓰기의 직렬화** 자체였다는 걸 숫자로 확인.
- **React StrictMode의 의도적 이중 실행이 대기열 순번을 항상 0번으로 만들었다.** 개발 모드에서 effect가 두 번 실행되는데, 첫 실행이 가상 유저 투입을 기다리는 사이 두 번째 실행이 쿨다운에 걸려 곧바로 대기열에 새치기해버린 것. `curl`로 백엔드 로직만 단독 검증했을 땐 전혀 안 드러나 브라우저 재현이 필수였던 사례.
- **테스트 정리 코드가 실서버를 조용히 망가뜨렸다.** BullMQ 큐 정리에 `queue.obliterate()`를 썼는데, 이게 "테스트가 만든 것"만이 아니라 **같은 이름의 큐를 쓰는 모든 프로세스가 공유하는 반복(repeat) job 스케줄러까지** 지워버렸다 — 로컬에서 `jest`를 돌릴 때마다 실행 중이던 개발 서버의 대기열 처리가 멈췄다. "전체 삭제" 계열 API는 공유 자원엔 함부로 쓰면 안 된다는 교훈.
- **로컬에선 늘 통과하던 테스트가 CI에서만 실패했다.** 대기열 순번을 `Date.now()`(밀리초)로 매겼는데, GitHub Actions 컨테이너 간 Redis 왕복이 로컬보다 빨라 두 요청이 같은 밀리초에 몰리면서 동점이 났고, Redis가 동점을 멤버 문자열 사전순으로 정렬해 늦게 온 사람이 먼저 온 사람을 앞질렀다. "CI 환경 특유의 우연"이 아니라 실제 트래픽이 몰릴 때도 재현 가능한 공정성 버그였다 — `Date.now()`를 Redis `INCR` 기반 단조 증가 시퀀스로 교체.
- **Grafana가 부팅만으로 메모리 상한의 99.95%를 다 썼다.** RAM 1GB VM에 여유 있어 보이라고 200MB로 잡았는데, 실측해보니 컨테이너가 뜨자마자 그 한도를 거의 다 채웠다 — 안 고쳤으면 실사용 중 확실히 OOM. "일단 작게 잡고 필요하면 늘리기"보다, 이런 무거운 소프트웨어는 여유 있게 잡고 실측 후 줄이는 게 더 안전하다는 걸 배웠다.

## 새 세션 / 다른 기기에서 이어가기

이 프로젝트의 맥락은 전부 파일로 남아 있다. 새 세션에서는 다음 순서로 catch-up한다.

1. [`docs/STATUS.md`](docs/STATUS.md) — 지금 어디까지 됐고 다음은 뭔지(항상 최신 스냅샷)
2. [`docs/DEVLOG.md`](docs/DEVLOG.md) — 시간순 개발 이력(결정·삽질·배운 점)
3. [`docs/decisions/`](docs/decisions/) — 모든 선택의 대안·근거(ADR)
4. `git log` — 커밋 단위 이력
