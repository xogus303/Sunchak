import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { PayDto } from './dto/pay.dto';

// 라우트: POST /reservations/:reservationId/pay (PRD API 초안과 동일 경로, ADR 0018)
@Controller('reservations')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // 202 — 결제 자체가 비동기(큐)라 "접수됨(PENDING)"을 즉시 반환하고, 실제 판정은
  // PaymentProcessor가 처리한다. 결과는 기존 예매 SSE 스트림으로 확인(CONFIRMED/CANCELLED).
  @UseGuards(JwtAuthGuard)
  @Post(':reservationId/pay')
  @HttpCode(HttpStatus.ACCEPTED)
  pay(
    @Param('reservationId', ParseIntPipe) reservationId: number,
    @CurrentUser() user: { id: number },
    @Body() dto: PayDto,
  ) {
    return this.paymentsService.pay(reservationId, user.id, dto.idempotencyKey);
  }
}
