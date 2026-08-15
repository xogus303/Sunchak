# 0018. 모의 결제 — 확정 트리거를 HELD 생성에서 결제 성공으로 이동

- 상태: Accepted
- 날짜: 2026-08-06
- 관련: 0005(BullMQ), 0006(SSE), 0009(스키마), 0014(예매 전략), 0015(정합성 설계), 0017(대기열)

> **오타 정정 (2026-08-08 — 배포 전 ADR 점검 중 발견)**: 아래 본문이 비교 근거로 인용하는 "HELD TTL 5분"은 PRD 원안의 숫자다 — 실제 `HELD_TTL_MS`는 이 ADR과 같은 날 있었던 다른 작업에서 **30초**로 조정됐다(`apps/api/src/reservations/reservations.service.ts`, DEVLOG "결제 TTL 30초" 항목 참고). 방향성 있는 비교(어떤 TTL이든 "기다리기" vs "즉시 반환")는 그대로 유효하니 본문은 안 고치고, 실제 숫자를 헷갈리지 않도록 여기 정정만 남긴다.

## 맥락 (Context)

PRD(`02_서비스_기획안.md`)는 예매 흐름을 "좌석 홀드(5분 타이머) → **모의 결제** → 성공 시 확정 / 실패·타임아웃 시 좌석 반환"으로 그렸고, 화면 정의(§6)에도 "모의 결제 버튼, 상태 폴링 — 비동기 상태(pending→done)"이 명시돼 있다. `Payment` 테이블도 이 흐름을 전제로 W1 ERD에서 이미 만들어졌다(`status: PENDING/PAID/FAILED`).

그런데 ADR 0015 구현 시점에 결제 자체는 만들지 않고 워커가 HELD를 곧바로 CONFIRMED로 뒤집게 해뒀다 — ADR 0015 본문에 이미 "이건 결제 stub이고, 실제론 결제 완료(PG 웹훅)가 confirm job을 태워야 한다"고 명시적으로 적어뒀다. 즉 이 자리는 애초부터 "나중에 결제가 끼어들 seam"으로 설계돼 있었다.

## 결정 (Decision)

**확정(confirm) job을 투입하는 시점을 "HELD 생성"에서 "결제 성공"으로 옮긴다.** 관문·HELD·기존 확정 워커(`ConfirmProcessor`)·SSE 스트림은 전혀 손대지 않는다 — 그 앞에 결제 단계 하나를 끼워 넣을 뿐이다.

```
[예매하기] → HELD (Payment 행 생성, status=PENDING, confirm job은 아직 안 넣음)
     │
[결제하기 클릭] → POST /reservations/:id/pay → 'payment' 큐에 job 투입 → 즉시 202(PENDING)
     │
[PaymentProcessor] → 80% 성공 / 20% 실패(모의, 랜덤)
     ├─ 성공 → Payment: PAID → 기존 'confirm' 큐에 job 투입(ConfirmProcessor 무변경 재사용) → HELD→CONFIRMED
     └─ 실패 → Payment: FAILED → Reservation: CANCELLED, Redis 재고 즉시 INCRBY 반환(사용자 확인 후 채택 — TTL 만료 대기 대신 즉시 반환), ReservationEventsService로 CANCELLED 방송
     │
[SSE] 기존 `/reservations/:id/stream` 무변경 — "HELD가 아니면 종료 상태"로 이미 일반화돼 있어 CONFIRMED든 CANCELLED든 그대로 흘려보낸다.
```

- **결제도 비동기(큐)**: PRD가 "비동기 상태(pending→done)"를 명시했고, 이 프로젝트의 학습 목표(큐·비동기)와도 맞아 confirm과 같은 BullMQ 패턴(`payment` 큐, `PaymentProcessor`)을 그대로 재사용한다.
- **`Payment.idempotencyKey` 재검토 결론(STATUS.md 백로그 항목 해소)**: Reservation의 `idempotencyKey`는 `[userId, idempotencyKey]` 복합 unique로 스코프를 좁혀야 했던 반면(같은 유저의 "재전송"과 "새 주문"을 구분해야 함 — 여러 Reservation 행이 한 유저에 속하므로), Payment는 **`reservationId`가 이미 `@unique`(1:1)** 라 결제 재시도 자체가 그걸로 원자적으로 막힌다. 별도 복합 unique가 필요 없다 — 실제 버그 아님으로 결론.
- **실패 시 즉시 반환**(vs HELD TTL 5분 대기): 방문자가 감으려감 없이 바로 다시 시도할 수 있고, 다른 대기자에게도 즉시 좌석이 풀린다.

## 고려한 대안 (Alternatives)

| 주제 | 대안 | 채택하지 않은 이유 |
|---|---|---|
| 결제 처리 방식 | `POST /pay`가 동기로 즉시 성공/실패 응답 | PRD가 명시한 "비동기 pending→done" UX와 안 맞고, 이 프로젝트의 큐 학습 포인트를 또 하나 놓친다. |
| 실패 시 반환 | HELD TTL(5분) 만료로 자연 반환(sweep 재사용) | 새 반환 로직 없이 기존 안전장치를 재사용하는 장점은 있지만, 사용자가 실패를 보고도 5분을 기다려야 해 UX가 나쁨(사용자 확인 후 기각). |
| 확정 트리거 | `PaymentProcessor`가 직접 Reservation을 CONFIRMED로 바꿈 | 기존 `ConfirmProcessor`(멱등 UPDATE)를 중복 구현하게 된다. 대신 성공 시 **기존 confirm 큐에 job만 투입**해 재사용 — 변경 범위 최소화. |

## 근거 (Rationale)

- **이 자리는 이미 "seam"으로 설계돼 있었다**: ADR 0015가 스스로 "결제 stub"이라 부르며 다음 단계를 예고해뒀다. 지금은 그 예고를 실행하는 것뿐 — 새 아키텍처가 아니라 미뤄둔 한 조각을 채우는 것.
- **기존 확정 경로를 재사용**하는 것이 "수술적 변경" 원칙에 맞는다. `ConfirmProcessor`는 이미 멱등하고 테스트돼 있다 — 성공 시 그 큐에 job을 넣는 것만으로 확정이 일어나게 하면 그 코드를 한 글자도 안 바꿔도 된다.
- **결제 성공률(80%)은 하드코딩**한다(env로 안 뺌) — 시뮬레이션 파라미터(0016/0017)와 달리 이건 핵심 비즈니스 로직 상수이고, 테스트에서 성공/실패 양쪽을 확인하려면 결정론적으로 만드는 게 더 나아 실제로는 테스트마다 `Math.random`을 모킹한다.

## 결과 (Consequences)

**이득**
- PRD의 결제 학습 포인트(비동기 처리, pending→done)가 완결된다.
- 기존 관문·HELD·확정·SSE 코드는 무변경.

**감수할 것**
- `reservations.service.spec.ts`의 "HELD 접수 후 자동 확정" 관련 테스트들이 더 이상 성립하지 않는다 — **의도된 동작 변경**(결제 없이 자동 확정되던 게 stub이었으므로)이라 테스트를 결제 성공 경로를 거치도록 갱신한다.
- 새 큐(`payment`) + 워커 하나가 운영 복잡도를 더한다.

**후속 작업(구현 시)**
- `createHeld()`에서 즉시 confirm job 투입 제거, 대신 `Payment` 행 생성.
- 신규 `payment.processor.ts`(같은 `reservations/` 모듈), `payments.controller.ts`(`POST /reservations/:id/pay`).
- 프론트: HELD 상태에 "결제하기" 버튼 추가, 결제 중(PENDING) 상태 표시.
