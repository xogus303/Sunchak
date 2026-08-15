"use client";

import { TicketCard } from "./ticket-card";
import type { TicketSummary } from "./use-demo-stats";

interface TicketListProps {
  tickets: TicketSummary[];
}

// "내 예매" 패널(booking-form.tsx) 바로 아래, 좌측에 배치된다(2026-08-07, 사용자
// 요청 — 이전엔 우측 판매현황 패널에 있었는데, "내 예매"와 물리적으로 멀어
// 눈에 안 띄었다). 같은 이유로 내 티켓을 "다른 참가자" 티켓과 섞지 않고
// 목록 맨 위에 별도 섹션으로 고정한다 — 유저별 격리(2026-08-07) 덕에 여기
// 뜨는 다른 참가자 티켓은 전부 이 유저 본인의 데모 이벤트에서 투입한 가상
// 유저뿐이라 실제 타인의 정보가 섞일 일은 없다.
export function TicketList({ tickets }: TicketListProps) {
  const mine = tickets.filter((t) => t.isMine);
  const others = tickets.filter((t) => !t.isMine);

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          내 티켓 ({mine.length}건)
        </h3>
        {mine.length === 0 && <p className="text-sm text-zinc-500">아직 예매한 티켓이 없습니다.</p>}
        {mine.length > 0 && (
          <div className="flex flex-col gap-2">
            {mine.map((ticket) => (
              <TicketCard
                key={ticket.id}
                reservationId={ticket.id}
                quantity={ticket.quantity}
                status={ticket.status}
                paymentStatus={ticket.paymentStatus}
                isMine
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          다른 참가자 티켓 ({others.length}건)
        </h3>
        {others.length === 0 && <p className="text-sm text-zinc-500">아직 없습니다.</p>}
        {others.length > 0 && (
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
            {others.map((ticket) => (
              <TicketCard
                key={ticket.id}
                reservationId={ticket.id}
                quantity={ticket.quantity}
                status={ticket.status}
                paymentStatus={ticket.paymentStatus}
                isMine={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
