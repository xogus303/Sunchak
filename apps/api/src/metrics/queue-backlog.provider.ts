import { Provider } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Gauge } from 'prom-client';
import { Queue } from 'bullmq';
import { CONFIRM_QUEUE, PAYMENT_QUEUE } from '../reservations/reservations.constants';

export const QUEUE_BACKLOG_GAUGE = 'QUEUE_BACKLOG_GAUGE';

// Gauge에 collect 콜백을 등록해두면, Prometheus가 /metrics를 긁으러 올 때마다
// 그 시점에 한 번만 실행돼 최신 큐 상태를 읽어온다 — 별도 폴링(setInterval)
// 없이도 항상 스크레이프 시점 기준 최신값을 보장한다(Prometheus의 pull 모델과
// 자연스럽게 맞물리는 방식).
export const queueBacklogGaugeProvider: Provider = {
  provide: QUEUE_BACKLOG_GAUGE,
  inject: [getQueueToken(CONFIRM_QUEUE), getQueueToken(PAYMENT_QUEUE)],
  useFactory: (confirmQueue: Queue, paymentQueue: Queue) => {
    return new Gauge({
      name: 'queue_backlog',
      help: '큐별 대기(waiting)+처리중(active) job 수',
      labelNames: ['queue', 'state'],
      async collect() {
        const [confirmWaiting, confirmActive, paymentWaiting, paymentActive] =
          await Promise.all([
            confirmQueue.getWaitingCount(),
            confirmQueue.getActiveCount(),
            paymentQueue.getWaitingCount(),
            paymentQueue.getActiveCount(),
          ]);
        this.set({ queue: 'confirm', state: 'waiting' }, confirmWaiting);
        this.set({ queue: 'confirm', state: 'active' }, confirmActive);
        this.set({ queue: 'payment', state: 'waiting' }, paymentWaiting);
        this.set({ queue: 'payment', state: 'active' }, paymentActive);
      },
    });
  },
};
