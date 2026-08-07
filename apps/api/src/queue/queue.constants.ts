// BullMQ 'admission'(입장 처리) 큐 이름 — 등록(module)·워커(processor)가 공유.
export const ADMISSION_QUEUE = 'admission';

// 주기마다 대기열 앞에서 몇 명씩 들여보내는가(ADR 0017). 0016 시뮬 배치(20명)와
// 같은 규모로 맞춰, 시뮬 투입 리듬과 입장 처리 리듬이 서로 압도하지 않게 한다.
export const ADMISSION_BATCH_SIZE = 20;

// 입장 처리 주기 — sweep(30s)·reconcile(1min)보다 훨씬 촘촘하게 돈다. 대기열은
// "지금 대기 인원이 줄어드는 걸 눈으로 본다"가 핵심이라 사람이 체감할 정도로 빨라야 한다.
export const ADMISSION_INTERVAL_MS = 2_000;

// 대기열이 비어있지 않은 이벤트 id를 모아두는 Redis Set. 입장 처리 워커가 매 틱마다
// "모든 이벤트"를 훑는 대신 이 목록만 훑도록 해 불필요한 조회를 줄인다.
export const ACTIVE_QUEUES_KEY = 'queues:active';
