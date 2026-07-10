# 0003. 데이터베이스: PostgreSQL

- 상태: Accepted
- 날짜: 2026-07-10

## 맥락 (Context)
선착순 예매의 핵심은 트랜잭션·격리 수준·락을 제대로 다루는 것이다. 학습을 위해 이 기능들을 신뢰성 있게, 표준적으로 실험할 수 있는 RDB가 필요하다.

## 결정 (Decision)
**PostgreSQL**을 사용한다.

## 고려한 대안 (Alternatives)
| 대안 | 장점 | 단점 / 채택하지 않은 이유 |
|---|---|---|
| **MySQL/MariaDB** | 국내 실무 점유율이 높고 자료 많음. 티켓팅 예제도 다수. | 격리 수준 기본값·락 동작이 Postgres와 다르고, 고급 기능(트랜잭션 격리 실험, `SKIP LOCKED` 등)의 명료함은 Postgres가 우위. |
| **SQLite** | 셋업 제로, 가장 간단. | 동시성/락 실험이 목적인데 SQLite는 쓰기 동시성이 제한적 → 학습 주제와 정면 충돌. 부적합. |
| **PostgreSQL** | 트랜잭션 격리 수준, `SELECT ... FOR UPDATE`, `SKIP LOCKED`, 낙관적 락 패턴을 명료하게 실험. `EXPLAIN ANALYZE`로 쿼리/인덱스 학습 최적. 표준 준수. | 특별한 단점 없음(학습 목적 기준). |

## 근거 (Rationale)
이 프로젝트의 W2(동시성)와 W1(인덱스/쿼리 최적화)이 전부 RDB의 트랜잭션·락·플래너를 깊게 다루는데, PostgreSQL은 그 학습에 가장 명료하고 표준적인 선택이다. `SKIP LOCKED` 같은 기능은 대기열/작업 큐 패턴을 SQL만으로 실험해 볼 여지도 준다.

## 결과 (Consequences)
- 격리 수준·락·인덱스를 깊게 파고들 수 있는 토대 확보.
- 로컬은 docker-compose의 `postgres:16-alpine`로 즉시 구동.
