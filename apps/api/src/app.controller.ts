import { Controller, Get } from '@nestjs/common';
import { Public } from './demo/decorators/public.decorator';

@Controller()
export class AppController {
  // 헬스체크 — 서버 기동 확인 및 (이후) 로드밸런서/모니터링용. 게이트보다
  // 먼저 열려있어야 한다(인프라 모니터링이 데모 토큰을 가질 리 없음).
  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'sunchak-api',
      time: new Date().toISOString(),
    };
  }
}
