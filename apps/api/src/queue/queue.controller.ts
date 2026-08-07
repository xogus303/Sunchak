import {
  Controller,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Param,
  ParseIntPipe,
  Post,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { QueueService } from './queue.service';

// 라우트: /events/:eventId/queue — 기획안(02_서비스_기획안.md §8)의 원래 API
// 초안 그대로(POST .../queue, GET .../queue/stream). 로그인 필요 — "누가 줄을
// 섰는지"를 알아야 순번을 매기고 나중에 그 사람에게 입장 허가를 줄 수 있다.
@Controller('events/:eventId/queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async join(
    @Param('eventId', ParseIntPipe) eventId: number,
    @CurrentUser() user: { id: number },
  ) {
    await this.queueService.join(eventId, user.id);
    return { joined: true };
  }

  @UseGuards(JwtAuthGuard)
  @Sse('stream')
  stream(
    @Param('eventId', ParseIntPipe) eventId: number,
    @CurrentUser() user: { id: number },
  ): Observable<MessageEvent> {
    return this.queueService.streamStatus(eventId, user.id);
  }
}
