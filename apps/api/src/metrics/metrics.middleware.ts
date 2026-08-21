import { Injectable, NestMiddleware } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Histogram } from 'prom-client';
import { NextFunction, Request, Response } from 'express';

type HttpLabels = 'method' | 'route' | 'status_code';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(
    @InjectMetric('http_requests_total')
    private readonly requestsTotal: Counter<HttpLabels>,
    @InjectMetric('http_request_duration_seconds')
    private readonly requestDuration: Histogram<HttpLabels>,
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();

    // 'finish'는 응답이 실제로 다 나간 뒤(상태 코드가 확정된 뒤) 발생한다.
    // NestJS 인터셉터에서 잡으면 예외 필터가 상태 코드를 쓰기 전이라 부정확할
    // 수 있는데, 여기선 그 문제가 없다.
    res.on('finish', () => {
      // 매칭된 라우트 패턴(예: '/events/:id')을 라벨로 쓴다. 원본 URL을 그대로
      // 쓰면 예약 id별로 라벨이 무한히 늘어나는 문제(high cardinality)가 생긴다.
      const route =
        (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      const labels = {
        method: req.method,
        route,
        status_code: String(res.statusCode),
      };
      this.requestsTotal.inc(labels);
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.requestDuration.observe(labels, seconds);
    });

    next();
  }
}
