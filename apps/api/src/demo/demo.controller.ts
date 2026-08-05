import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Post,
  Sse,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { DemoService } from './demo.service';
import { GateDto } from './dto/gate.dto';
import { SimulateDto } from './dto/simulate.dto';
import { Public } from '../common/decorators/public.decorator';

@Controller('demo')
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  // 게이트 자신은 전역 가드보다 먼저 열려있어야 한다 — 그래야 애초에 토큰을
  // 발급받을 수 있다(닭이 먼저냐 달걀이 먼저냐 문제 회피).
  @Public()
  @Post('gate')
  enterGate(@Body() dto: GateDto) {
    return this.demoService.enterGate(dto.password);
  }

  // ⚠️ 데모 전용, 파괴적 엔드포인트(예매 전체 삭제 + 재고 원복).
  // 전역 게이트 가드(DemoGateGuard)로 보호된다 — 별도 가드 불필요.
  @Post('reset')
  reset() {
    return this.demoService.resetDemoEvent();
  }

  // 서버측 부하 시뮬레이션(ADR 0016 축 B-1). 상한·쿨다운 통과 즉시 202로
  // 응답하고, 실제 투입은 백그라운드에서 진행한다(진행 상황은 축 B-2 SSE 몫).
  // 전역 게이트 가드로 보호 — 게이트 통과자라면 누구든 호출 가능(쿨다운은 전역 공유).
  @Post('simulate')
  @HttpCode(HttpStatus.ACCEPTED)
  simulate(@Body() dto: SimulateDto) {
    return this.demoService.simulateLoad(dto.virtualUserCount);
  }

  // 실시간 판매 대시보드(ADR 0016 축 B-2). 재고·HELD/CONFIRMED·큐 적체를
  // 1초 주기로 스냅샷 push. 전역 게이트 가드로 보호 — 개인 데이터가 아니라
  // JWT 로그인은 불필요(게이트만 통과하면 누구나 같은 화면을 본다).
  @Sse('stats/stream')
  statsStream(): Promise<Observable<MessageEvent>> {
    return this.demoService.streamStats();
  }
}
