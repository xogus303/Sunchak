import { Controller, Post } from '@nestjs/common';
import { DemoService } from './demo.service';

// ⚠️ 데모 전용, 파괴적 엔드포인트(예매 전체 삭제 + 재고 원복).
// 아직 진입 게이트(ADR 0016 축 A)가 없어 지금은 가드가 없다 — 게이트 구현 시
// 그 가드로 이 엔드포인트를 보호한다(로컬 개발 단계라 당장은 무해).
@Controller('demo')
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  @Post('reset')
  reset() {
    return this.demoService.resetDemoEvent();
  }
}
