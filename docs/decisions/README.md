# 의사결정 기록 (ADR — Architecture Decision Records)

이 폴더는 프로젝트의 **모든 중요한 선택**(아키텍처, 기술 스택, 비즈니스 로직)을 "왜 그렇게 정했는가"와 함께 남기는 곳이다. 학습이 최우선이므로, 결정의 **대안과 근거**를 반드시 함께 기록한다. 대안이 없는 경우엔 선택 근거만 적는다.

이 관행을 업계에서는 **ADR(Architecture Decision Record)** 라 부른다. 결정 하나당 파일 하나로, 번호를 매겨 시간순으로 쌓는다. 지나간 결정은 지우지 않고 `Superseded`(대체됨)로 표시해 사고의 흐름 자체를 남긴다 — 이게 나중에 회고와 면접의 핵심 자료가 된다.

## 파일 규칙
- 파일명: `NNNN-짧은-제목.md` (예: `0001-backend-framework-nestjs.md`)
- 번호는 4자리, 시간순 증가.
- 상태: `Accepted`(채택) / `Superseded by NNNN`(대체됨) / `Proposed`(검토중).

## 템플릿

```markdown
# NNNN. <결정 제목>

- 상태: Accepted
- 날짜: YYYY-MM-DD
- 관련: (연결되는 다른 ADR 번호)

## 맥락 (Context)
어떤 문제/요구 때문에 이 결정이 필요했는가.

## 결정 (Decision)
무엇을 선택했는가.

## 고려한 대안 (Alternatives)
| 대안 | 장점 | 단점 / 채택하지 않은 이유 |
|---|---|---|

## 근거 (Rationale)
왜 이 선택이 이 프로젝트의 목표(학습 > 포트폴리오)에 맞는가.

## 결과 (Consequences)
이 선택으로 생기는 이득과 감수해야 할 것.
```

## 목록 (Index)

| # | 결정 | 상태 |
|---|---|---|
| [0001](./0001-backend-framework-nestjs.md) | 백엔드 프레임워크: NestJS | Accepted |
| [0002](./0002-orm-prisma.md) | ORM: Prisma | Accepted |
| [0003](./0003-database-postgresql.md) | 데이터베이스: PostgreSQL | Accepted |
| [0004](./0004-redis.md) | Redis 도입 | Accepted |
| [0005](./0005-queue-bullmq.md) | 큐: BullMQ | Accepted |
| [0006](./0006-realtime-sse.md) | 실시간 전송: SSE | Accepted |
| [0007](./0007-monorepo.md) | 저장소 구조: 모노레포 | Accepted |
| [0008](./0008-frontend-nextjs.md) | 프론트엔드: Next.js | Accepted |
| [0009](./0009-db-schema-design.md) | 초기 DB 스키마 설계 | Accepted |
| [0010](./0010-db-hosting-neon.md) | 개발 DB 호스팅: Neon 공유 + Redis 로컬 | Accepted |
| [0011](./0011-secrets-infisical.md) | 비밀값 관리: Infisical | Accepted |
| [0012](./0012-package-manager-pnpm.md) | 패키지 매니저: pnpm (corepack) | Accepted |
| [0013](./0013-auth-approach.md) | 인증: argon2 해싱 + JWT + DTO 검증 | Accepted |
| [0014](./0014-reservation-strategy.md) | 선착순 예매 재고 차감: Redis 관문 + DB 비동기 기록 | Accepted |
| [0015](./0015-reservation-consistency-design.md) | 예매 정합성 설계: HELD 선기록 + BullMQ 큐 + 멱등성 + SSE | Accepted |
| [0016](./0016-public-demo-mode.md) | 공개 데모 모드: 진입 게이트 + 데모 장치 + 데이터 리셋 | Accepted |
