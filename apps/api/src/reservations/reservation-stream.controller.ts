import {
  Controller,
  MessageEvent,
  Param,
  ParseIntPipe,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ReservationsService } from './reservations.service';

// 라우트: GET /reservations/:reservationId/stream
// 예매 하나의 상태 변화(확정)를 SSE로 실시간 구독한다.
@Controller('reservations')
export class ReservationStreamController {
  constructor(private readonly reservationsService: ReservationsService) {}

  // @Sse: 이 핸들러가 반환하는 Observable을 NestJS가 구독해, emit되는 MessageEvent를
  // SSE 전선 포맷(data: ...\n\n)으로 바꿔 연결에 흘려보낸다. 연결 유지·종료도 NestJS 몫.
  // 핸들러가 Observable을 반환하기 '전'(await assertOwned)에 던진 예외는 정상 404/403.
  @UseGuards(JwtAuthGuard)
  @Sse(':reservationId/stream')
  async stream(
    @Param('reservationId', ParseIntPipe) reservationId: number,
    @CurrentUser() user: { id: number },
  ): Promise<Observable<MessageEvent>> {
    await this.reservationsService.assertOwned(reservationId, user.id);
    return this.reservationsService.streamStatus(reservationId);
  }
}
