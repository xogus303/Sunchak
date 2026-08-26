import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Post,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { LoadTestService } from './load-test.service';
import { ResetLoadTestDto } from './dto/reset-load-test.dto';
import { SimulateLoadTestDto } from './dto/simulate-load-test.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

// 라우트: /load-test — 캐주얼 데모(/demo)와 완전히 별도(ADR 0016 백로그).
// 전역 게이트 가드(DemoGateGuard)는 @Public() 없는 모든 라우트에 이미
// 적용되므로 여기 따로 걸 필요 없다. 로그인은 명시적으로 요구한다 — "누구의"
// 대용량 테스트 이벤트인지 알아야 한다(demo.controller.ts와 같은 이유).
@Controller('load-test')
export class LoadTestController {
  constructor(private readonly loadTestService: LoadTestService) {}

  @UseGuards(JwtAuthGuard)
  @Post('reset')
  reset(@Body() dto: ResetLoadTestDto, @CurrentUser() user: { id: number }) {
    return this.loadTestService.reset(dto.totalQty, user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('simulate')
  @HttpCode(HttpStatus.ACCEPTED)
  simulate(
    @Body() dto: SimulateLoadTestDto,
    @CurrentUser() user: { id: number },
  ) {
    return this.loadTestService.simulateLoad(dto.virtualUserCount, user.id);
  }

  // 실시간 결과 대시보드(demo.controller.ts의 stats/stream과 같은 목적).
  @UseGuards(JwtAuthGuard)
  @Sse('stats/stream')
  statsStream(@CurrentUser() user: { id: number }): Promise<Observable<MessageEvent>> {
    return this.loadTestService.streamStats(user.id);
  }

  // 방문자 본인이 대용량 이벤트 대기열에 직접 입장(2026-08-26, ADR 0017 패턴을
  // 대용량에도 제공) — queue.controller.ts의 `/events/:eventId/queue`와 달리
  // URL에 eventId가 없다(`/load-test/*`는 전부 "내 이벤트" 기준). 응답에
  // eventId를 실어줘 프론트가 이후 예매 호출에 쓸 수 있게 한다.
  @UseGuards(JwtAuthGuard)
  @Post('queue')
  @HttpCode(HttpStatus.ACCEPTED)
  joinQueue(@CurrentUser() user: { id: number }) {
    return this.loadTestService.joinQueue(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Sse('queue/stream')
  queueStream(@CurrentUser() user: { id: number }): Promise<Observable<MessageEvent>> {
    return this.loadTestService.streamQueueStatus(user.id);
  }
}
