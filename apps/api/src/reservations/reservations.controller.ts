import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  ReservationsService,
  ReservationStrategy,
} from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { QueueService } from '../queue/queue.service';

// 라우트: POST /events/:eventId/reservations — "이 이벤트에 예매를 만든다"
@Controller('events/:eventId/reservations')
export class ReservationsController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly queueService: QueueService,
  ) {}

  // 로그인 필요(예매자 식별). JWT 통과 시 request.user에 담긴 값을 @CurrentUser로 꺼낸다.
  // ?strategy= 로 동시성 전략을 고른다(W2 벤치마크용, 생략 시 서비스 기본=atomic).
  // held(=실제 사용자 흐름)에서만 대기열 입장 허가를 요구한다(ADR 0017) — W2
  // 5전략 벤치마크는 대기열과 무관하므로 이 체크 대상이 아니다.
  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Param('eventId', ParseIntPipe) eventId: number,
    @CurrentUser() user: { id: number },
    @Body() dto: CreateReservationDto,
    @Query('strategy') strategy?: ReservationStrategy,
  ) {
    if (strategy === 'held') {
      await this.queueService.assertAdmitted(eventId, user.id);
    }
    return this.reservationsService.create(
      eventId,
      user.id,
      dto.quantity,
      strategy,
      dto.idempotencyKey,
    );
  }
}
