import { Controller, Get, Res } from '@nestjs/common';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';

// 라이브러리 기본 컨트롤러 대신 직접 확장한다 — 전역 게이트 가드
// (DemoGateGuard)가 모든 라우트를 막는데, Prometheus는 데모 토큰을 들고
// 오지 않으므로 이 라우트만 @Public()으로 예외를 둬야 한다. Prometheus
// 컨테이너는 공인 인터넷이 아니라 VM 내부 Docker 네트워크로만 이 주소에
// 접근하므로(Nginx가 이 경로를 라우팅하지 않음) 인증 없이 공개해도 안전하다.
@Public()
@Controller()
export class MetricsController extends PrometheusController {
  // 경로를 안 주는 이유: PrometheusModule.register()가 부팅 시 이 클래스의
  // path 메타데이터를 자기 옵션(기본값 '/metrics')으로 강제 덮어쓴다
  // (라이브러리 소스 module.js의 configureServer 참고). 여기서 경로를 또
  // 지정하면 '/metrics/metrics'가 돼버린다.
  @Get()
  index(@Res({ passthrough: true }) response: Response) {
    return super.index(response);
  }
}
