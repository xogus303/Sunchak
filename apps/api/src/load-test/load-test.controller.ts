import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
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
}
