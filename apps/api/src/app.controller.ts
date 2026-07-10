import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  // 헬스체크 — 서버 기동 확인 및 (이후) 로드밸런서/모니터링용
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'sunchak-api',
      time: new Date().toISOString(),
    };
  }
}
