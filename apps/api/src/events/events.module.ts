import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';

@Module({
  controllers: [EventsController],
  providers: [EventsService],
  // DemoService가 findOrCreateOwnDemoEvent()로 "이 유저의 데모 이벤트"를
  // 얻어 쓴다(2026-08-07, 유저별 격리).
  exports: [EventsService],
})
export class EventsModule {}
