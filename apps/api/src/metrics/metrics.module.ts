import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  PrometheusModule,
  makeCounterProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { CONFIRM_QUEUE, PAYMENT_QUEUE } from '../reservations/reservations.constants';
import { MetricsController } from './metrics.controller';
import { MetricsMiddleware } from './metrics.middleware';
import { queueBacklogGaugeProvider } from './queue-backlog.provider';

@Module({
  imports: [
    PrometheusModule.register({
      controller: MetricsController,
      // process_cpu_seconds_total, nodejs_eventloop_lag_seconds 등
      // Node.js/프로세스 표준 지표 — 라이브러리 기본값 그대로(true) 사용.
      defaultMetrics: { enabled: true },
    }),
    // queueBacklogGaugeProvider가 큐 상태를 읽으려면 Queue 인스턴스가
    // 필요하다. ReservationsModule이 이미 이 이름들로 등록해뒀지만 그건
    // export 안 된 자기 모듈 스코프 provider라, 여기서 같은 이름으로 한 번
    // 더 등록한다(defaultJobOptions 없이 — job을 넣지 않고 읽기만 하므로
    // 불필요). 같은 이름으로 등록해도 같은 Redis 큐를 가리키는 별도 클라이언트
    // 핸들이 생길 뿐이라 안전하다(BullMQ의 정상적인 다중 클라이언트 패턴).
    BullModule.registerQueue({ name: CONFIRM_QUEUE }, { name: PAYMENT_QUEUE }),
  ],
  providers: [
    makeCounterProvider({
      name: 'http_requests_total',
      help: 'HTTP 요청 처리 총 횟수',
      labelNames: ['method', 'route', 'status_code'],
    }),
    makeHistogramProvider({
      name: 'http_request_duration_seconds',
      help: 'HTTP 요청 처리 시간(초) — Grafana에서 p95 등을 계산하는 원자료',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    }),
    queueBacklogGaugeProvider,
    MetricsMiddleware,
  ],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MetricsMiddleware).forRoutes('*');
  }
}
