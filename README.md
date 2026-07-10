# Sunchak

소규모 공연·클래스 **선착순 예매 서비스**. 프론트엔드 개발자의 풀스택 전환 학습 + 포트폴리오용 사이드 프로젝트.

순간 대량 트래픽 상황에서 **초과 판매 0**을 보장하는 동시성 제어, 실시간 대기열(SSE), 비동기 결제(큐)를 핵심으로 다룬다.

## 스택

- **Frontend**: Next.js (App Router) + TypeScript + TanStack Query + Tailwind → Vercel 배포
- **Backend**: NestJS + TypeScript, Prisma
- **Data**: PostgreSQL, Redis
- **Queue**: BullMQ
- **Realtime**: SSE
- **Infra**: Docker / docker-compose, 클라우드 VM + Nginx, GitHub Actions, Prometheus + Grafana
- **Load test**: k6

## 폴더 구조

```
sunchak/
├── docs/           기획·설계·이력 문서
│   ├── 01_기술_로드맵.md
│   ├── 02_서비스_기획안.md
│   ├── DEVLOG.md          개발 이력(작업 로그)
│   └── decisions/         의사결정 기록(ADR) — 모든 선택의 대안·근거
├── apps/
│   ├── api/        NestJS 백엔드 (예정)
│   └── web/        Next.js 프론트엔드 (예정)
└── infra/
    └── docker-compose.yml   로컬 postgres + redis
```

## 로컬 실행 (준비 단계)

```bash
cd infra
docker compose up -d      # postgres(5432) + redis(6379)
```

## 진행 상황

- [x] 기획안 / 기술 로드맵 작성
- [x] 프로젝트 구조 & 인프라(로컬 DB/Redis) 세팅
- [ ] W1: 인증 + 이벤트 CRUD + DB 설계
- [ ] W2: 동시성 실험 (락 3종 + Redis) + k6
- [ ] W3: 대기열(SSE) + 비동기 결제(BullMQ)
- [ ] W4: 배포(VM) + CI/CD + 관측

자세한 계획은 [`docs/`](./docs) 참고.
