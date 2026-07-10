# 0009. 초기 DB 스키마 설계

- 상태: Accepted
- 날짜: 2026-07-10
- 관련: 0002(Prisma), 0003(PostgreSQL). W2 동시성 실험의 기반.

## 맥락 (Context)
PRD(`docs/02_서비스_기획안.md` §7)의 ERD를 Prisma 스키마로 구현한다. 이 스키마는 단순 CRUD용이 아니라 **W2 동시성 실험(초과 판매 0)과 W3 비동기 결제(멱등성)의 토대**다. 따라서 각 컬럼·인덱스가 뒤 주차의 학습 목표와 어떻게 연결되는지가 설계 기준이다.

아래는 이 스키마에서 내린 개별 결정과 대안들이다.

## 결정 (Decision)

### 1) 기본키(PK): `Int @default(autoincrement())`
정수 auto-increment를 PK로 쓴다.

| 대안 | 장점 | 단점 / 채택하지 않은 이유 |
|---|---|---|
| **UUID v4** | 추측 불가(열거 공격 방어), 분산 생성 가능. | 랜덤값이라 B-tree 인덱스에 무작위 삽입 → 페이지 분할·단편화로 삽입/인덱스 성능 저하. 16바이트로 인덱스가 커짐. |
| **cuid/uuid v7(정렬형)** | 열거 방어 + 시간순 정렬로 삽입 지역성 확보. | 이번 학습 초점(인덱스·`EXPLAIN ANALYZE`)에 불필요한 변수 추가. |
| **Int autoincrement (채택)** | 작고(4B) 순차 삽입이라 인덱스 지역성 최고, 조인·정렬이 빠름. `EXPLAIN` 결과가 깔끔해 인덱스 학습에 유리. | 순차 ID가 URL에 노출되면 총 예매 수 등이 **열거·추측**됨. |

**감수 사항 & 향후**: 순차 ID 노출 문제는 실서비스에선 공개용 별도 컬럼(slug/uuid)으로 가린다. 이번엔 학습 초점을 인덱스·쿼리에 두기 위해 Int로 가고, 노출 방어가 필요해지면 그때 public id 컬럼을 추가(향후 ADR로 기록).

### 2) 재고를 `Inventory` 테이블로 분리 (Event 1:1)
`remainingQty`·`version`을 `Event`에서 떼어 별도 테이블로 둔다.

- **근거**: W2에서 재고 차감은 `SELECT ... FOR UPDATE` 등으로 **행을 잠근다**. 이 컬럼이 `Event`에 섞여 있으면, 상세페이지를 읽는 수많은 조회 트래픽과 구매 트래픽이 **같은 행을 두고 경합**한다. 재고만 작은 테이블로 분리하면 **락 경합 범위가 좁아지고**, 읽기(이벤트 정보)와 쓰기(재고 차감)가 서로를 막지 않는다. 이 분리 자체가 "왜 티켓팅이 이렇게 설계하는가"의 핵심 학습 포인트다.
- **대안**: `Event`에 `remainingQty`를 그대로 두기 — 스키마는 단순하지만 위 경합 문제를 그대로 안게 되어 채택하지 않음.

### 3) 상태값을 Postgres enum으로
`Role`, `EventStatus`, `ReservationStatus`, `PaymentStatus`를 Prisma enum(→ Postgres 네이티브 enum 타입)으로 정의.

| 대안 | 장점 | 단점 |
|---|---|---|
| **String + 앱 레벨 검증** | 값 추가/변경 시 마이그레이션 불필요, 유연. | DB가 무결성을 보장 못 함(오타·잘못된 값이 들어갈 여지). |
| **Postgres enum (채택)** | DB 레벨에서 허용값 강제, 타입 안전, Prisma 타입으로 그대로 노출. | enum 값 추가 시 `ALTER TYPE` 마이그레이션 필요(약간의 마찰). |

상태 전이(HELD→CONFIRMED 등)가 도메인 핵심이라 **DB가 값을 강제**하는 편이 안전하다고 판단. enum 변경 마찰은 감수.

### 4) 금액은 `Int`(원 단위 정수)
`price`, `amount`를 원(KRW) 정수로 저장.

- **근거**: 돈에 `Float`를 쓰면 부동소수 오차가 난다(절대 금지). KRW는 최소 단위가 원이라 보조단위가 없으므로 정수 원으로 저장하면 정확하고 단순하다.
- **대안**: `Decimal` — 보조단위(센트 등)가 있는 통화라면 정석이지만, KRW 단일 통화 프로젝트엔 과함.

### 5) 인덱스 설계 (조회 패턴 기반)
- `User.email @unique` — 로그인 조회 + 중복 가입 방지.
- `Event @@index([status, openAt])` — 목록은 status로 필터 후 openAt 정렬. 복합 인덱스로 커버.
- `Reservation @@index([userId])` — "내 예매 내역".
- `Reservation @@index([eventId, status])` — 관리자 판매 현황·상태별 집계.
- `Reservation @@index([status, heldUntil])` — 만료 홀드 스윕 워커(W3)가 `HELD` + `heldUntil < now` 를 스캔.
- `Payment.idempotencyKey @unique` — 멱등키. `reservationId @unique` — 1:1.

**향후 최적화**: `status='HELD'` 행만 대상으로 하는 **부분 인덱스(partial index)** 가 만료 스윕에 이상적이나, Prisma 스키마 문법으로는 직접 표현이 어렵다. W2~W3에서 raw SQL 마이그레이션으로 도입을 검토(그때 별도 기록).

### 6) 낙관적 락용 `version` 컬럼
`Inventory.version Int @default(0)` — W2에서 낙관적 락 실험용. UPDATE 시 `WHERE version = ?` 로 경합을 감지하고 성공 시 +1 한다. 비관적 락(`FOR UPDATE`)과 처리량/정합성을 비교하는 재료.

## 근거 (Rationale)
스키마의 모든 비표준적 선택(재고 분리, version, 멱등키, status 인덱스)이 **W2 동시성·W3 큐 학습과 1:1로 대응**하도록 설계했다. "지금 당장 동작"보다 "뒤에서 실험할 거리를 스키마에 심어두는 것"이 학습 우선 원칙에 맞다.

## 결과 (Consequences)
- W2에서 `Inventory` 한 행을 두고 비관/낙관/Redis 3종 실험을 바로 할 수 있다.
- enum 값 추가 시 마이그레이션이 필요하다(감수).
- 순차 PK 노출 방어는 향후 과제로 남긴다.
- 만료 홀드용 부분 인덱스는 raw SQL로 별도 도입 예정.
