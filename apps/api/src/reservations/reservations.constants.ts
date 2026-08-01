// BullMQ 'confirm'(확정) 큐 이름.
// 큐 등록(module) · job 투입(service) · 워커(processor)가 이 한 문자열을 공유한다.
// 상수로 묶어 오타로 인한 문자열 불일치(연결 실패)를 원천 차단.
export const CONFIRM_QUEUE = 'confirm';

// W3 2.5 안전장치 — 둘 다 '누가 요청해서'가 아니라 '시간 자체가 트리거'라 BullMQ의
// repeatable job(자기 자신을 주기적으로 재생성)으로 돈다. confirm과 달리 외부에서
// queue.add를 호출하지 않고, 각 프로세서가 자기 큐에 스스로 등록한다.
export const SWEEP_QUEUE = 'sweep'; // HELD TTL 만료 회수
export const RECONCILE_QUEUE = 'reconcile'; // Redis 재고 재구성(총재고−(HELD+CONFIRMED))

export const SWEEP_INTERVAL_MS = 30_000; // 30초 — HELD_TTL_MS(5분)보다 훨씬 촘촘
export const RECONCILE_INTERVAL_MS = 60_000; // 1분 — 정상 운영 중에도 생기는 미세한 어긋남 보정
