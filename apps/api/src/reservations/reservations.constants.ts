// BullMQ 'confirm'(확정) 큐 이름.
// 큐 등록(module) · job 투입(service) · 워커(processor)가 이 한 문자열을 공유한다.
// 상수로 묶어 오타로 인한 문자열 불일치(연결 실패)를 원천 차단.
export const CONFIRM_QUEUE = 'confirm';
