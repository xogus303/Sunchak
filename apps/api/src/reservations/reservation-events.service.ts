import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ReservationStatus } from '@prisma/client';

// 방송 한 건의 모양 — "몇 번 예매가 어떤 상태가 됐는지".
export interface ReservationStatusEvent {
  reservationId: number;
  status: ReservationStatus;
}

/**
 * 예매 상태 변화를 프로세스 안에서 중계하는 '방송국'. (W3 파이프라인 SSE용)
 *
 * 워커(ConfirmProcessor)와 SSE 엔드포인트는 서로를 참조하지 않는(loose coupling)
 * 별개 실행 맥락이라 값을 직접 못 넘긴다. 그래서 이 공용 버스를 거친다.
 *   - 워커: 확정 직후 publish()로 송출.
 *   - SSE:  ofReservation()로 자기 예약번호만 걸러 구독.
 *
 * ⚠️ 한계: Subject는 '이 프로세스의 메모리'에 있는 객체다. 워커와 웹서버가 같은
 * 프로세스일 때만 통한다. 워커를 별도 프로세스로 분리하면(ADR '별도 프로세스',
 * 운영 관심사라 후순위) 이 인메모리 버스는 깨지고 Redis pub/sub 등으로 바꿔야 한다.
 */
@Injectable()
export class ReservationEventsService {
  // 방송국 본체. next()로 송출, subscribe()로 수신되는 '양면' Observable.
  private readonly events$ = new Subject<ReservationStatusEvent>();

  // 송출 — 누가 듣는지 모른 채 방송만 한다.
  publish(event: ReservationStatusEvent): void {
    this.events$.next(event);
  }

  // 특정 예매의 이벤트만 걸러낸 '구독 전용' 스트림을 돌려준다.
  // (Subject를 그대로 노출하지 않는다 — 밖에서 마음대로 next() 못 하게.)
  ofReservation(reservationId: number): Observable<ReservationStatusEvent> {
    return this.events$.pipe(filter((e) => e.reservationId === reservationId));
  }
}
