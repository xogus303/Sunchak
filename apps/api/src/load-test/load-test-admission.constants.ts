// BullMQ 대용량 트래픽 테스트 전용 입장 처리 큐 이름 — 캐주얼 데모의 'admission'
// 큐(queue/queue.constants.ts)와 완전히 별개(ADR 0016 백로그).
export const LOAD_TEST_ADMISSION_QUEUE = 'load-test-admission';
