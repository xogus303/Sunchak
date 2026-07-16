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

// 라우트: POST /events/:eventId/reservations — "이 이벤트에 예매를 만든다"
@Controller('events/:eventId/reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  // 로그인 필요(예매자 식별). JWT 통과 시 request.user에 담긴 값을 @CurrentUser로 꺼낸다.
  // ?strategy= 로 동시성 전략을 고른다(W2 벤치마크용, 생략 시 서비스 기본=atomic).
  @UseGuards(JwtAuthGuard)
  @Post()
  create(
    @Param('eventId', ParseIntPipe) eventId: number,
    @CurrentUser() user: { id: number },
    @Body() dto: CreateReservationDto,
    @Query('strategy') strategy?: ReservationStrategy,
  ) {
    return this.reservationsService.create(
      eventId,
      user.id,
      dto.quantity,
      strategy,
    );
  }
}
