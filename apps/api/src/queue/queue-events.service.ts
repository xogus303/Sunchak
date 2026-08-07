import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';

// 방송 한 건의 모양 — "이 이벤트의 이 사용자가 입장 허가를 받았다".
export interface AdmissionEvent {
  eventId: number;
  userId: number;
}

/**
 * 입장 허가를 프로세스 안에서 중계하는 '방송국'. (ADR 0017)
 *
 * ReservationEventsService(확정 방송)와 같은 이유로 존재한다 — 입장 처리 워커
 * (AdmissionProcessor)와 "허가를 기다리는 쪽"은 서로 참조 없는 별개 실행 맥락이라
 * 값을 직접 못 넘긴다. 실사용자의 SSE 순번 확인은 폴링(QueueService.streamStatus)이면
 * 충분하지만, 가상 유저의 "허가 받으면 자동으로 예매 시도"(DemoService)는 폴링 루프를
 * 수백 개 띄우는 대신 이 버스를 구독해 기다린다.
 */
@Injectable()
export class QueueEventsService {
  private readonly admissions$ = new Subject<AdmissionEvent>();

  publish(event: AdmissionEvent): void {
    this.admissions$.next(event);
  }

  ofUser(eventId: number, userId: number): Observable<AdmissionEvent> {
    return this.admissions$.pipe(
      filter((e) => e.eventId === eventId && e.userId === userId),
    );
  }
}
