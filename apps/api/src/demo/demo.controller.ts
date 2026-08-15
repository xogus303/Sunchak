import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Post,
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { DemoService } from './demo.service';
import { GateDto } from './dto/gate.dto';
import { SimulateDto } from './dto/simulate.dto';
import { Public } from '../common/decorators/public.decorator';
import { authCookieOptions, DEMO_TOKEN_COOKIE } from '../common/auth-cookie';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('demo')
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  // 게이트 자신은 전역 가드보다 먼저 열려있어야 한다 — 그래야 애초에 토큰을
  // 발급받을 수 있다(닭이 먼저냐 달걀이 먼저냐 문제 회피).
  @Public()
  @Post('gate')
  async enterGate(
    @Body() dto: GateDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.demoService.enterGate(dto.password);
    // 쿠키(브라우저 EventSource·fetch가 자동 전송)로도 심는다 — JSON 응답의
    // demoToken은 curl 등 수동 검증용으로 그대로 유지(passthrough:true라 이
    // return 값을 Nest가 여전히 알아서 직렬화해 응답 본문에 담는다).
    res.cookie(DEMO_TOKEN_COOKIE, result.demoToken, authCookieOptions());
    return result;
  }

  // ⚠️ 데모 전용, 파괴적 엔드포인트(예매 전체 삭제 + 재고 원복).
  // 전역 게이트 가드(DemoGateGuard) + 로그인 필요 — "누구의" 데모 이벤트를
  // 리셋할지 알아야 한다(2026-08-07, 유저별 격리 — 예전엔 전역 이벤트 하나를
  // 리셋해서 다른 사람이 테스트 중인 데이터까지 지워버렸다).
  @UseGuards(JwtAuthGuard)
  @Post('reset')
  reset(@CurrentUser() user: { id: number }) {
    return this.demoService.resetDemoEvent(user.id);
  }

  // 서버측 부하 시뮬레이션(ADR 0016 축 B-1). 상한·쿨다운 통과 즉시 202로
  // 응답하고, 실제 투입은 백그라운드에서 진행한다(진행 상황은 축 B-2 SSE 몫).
  // 로그인 필요(2026-08-07, 유저별 격리) — "누구의" 이벤트에 투입할지 알아야 한다.
  @UseGuards(JwtAuthGuard)
  @Post('simulate')
  @HttpCode(HttpStatus.ACCEPTED)
  simulate(@Body() dto: SimulateDto, @CurrentUser() user: { id: number }) {
    return this.demoService.simulateLoad(dto.virtualUserCount, user.id, dto.auto);
  }

  // 실시간 판매 대시보드(ADR 0016 축 B-2). 재고·HELD/CONFIRMED·큐 적체를
  // 1초 주기로 스냅샷 push. 로그인 필요(2026-08-07, 유저별 격리) — "누구의"
  // 이벤트를 보여줄지 알아야 한다(예전엔 전역 이벤트 하나를 누구나 같이 봤다).
  @UseGuards(JwtAuthGuard)
  @Sse('stats/stream')
  statsStream(@CurrentUser() user: { id: number }): Promise<Observable<MessageEvent>> {
    return this.demoService.streamStats(user.id);
  }
}
