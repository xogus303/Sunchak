// BookingForm(내 예매 진행 상황)과 DemoDashboard(전체 티켓 그리드)가 함께 쓰는
// "티켓처럼 보이는" 카드 하나 — 사용자 피드백(2026-08-07): "예매하기를 누르면
// held가 하나 올라가는 건 맞는데 직관적이지 않다. 티켓 카드로 보여주자."
import type { ReactNode } from "react";

type TicketStatus = "HELD" | "CONFIRMED" | "EXPIRED" | "CANCELLED";
type PaymentStatus = "PENDING" | "PAID" | "FAILED" | null;

export interface TicketCardProps {
  quantity: number;
  status: TicketStatus;
  paymentStatus: PaymentStatus;
  isMine: boolean;
  reservationId?: number;
  children?: ReactNode; // 결제하기 버튼 등, 상태에 따른 액션을 카드 안에 얹는다
}

// (라벨, 테두리·배지 색) — 유저별 격리(2026-08-07) 이후 이 목록엔 내 티켓과
// 가상 유저 티켓이 같이 뜨므로, isMine과 별개로 상태 자체도 한눈에 구분돼야 한다.
function statusLabel(status: TicketStatus, paymentStatus: PaymentStatus) {
  if (status === "HELD") {
    return paymentStatus === "PENDING"
      ? { text: "결제 처리 중", tone: "amber" as const }
      : { text: "결제 대기", tone: "amber" as const };
  }
  if (status === "CONFIRMED") return { text: "확정", tone: "green" as const };
  // "취소됨"은 사용자가 직접 취소한 것처럼 들려 오해를 산다(2026-08-08 피드백) —
  // 실제로는 결제를 시도했는데 20% 확률로 실패한 경우다(ADR 0018, PaymentProcessor).
  // "예매를 시도조차 안 하고 30초를 넘겨 자동 만료"되는 EXPIRED와 구분되는 문구.
  if (status === "CANCELLED") return { text: "결제 실패", tone: "red" as const };
  return { text: "만료됨", tone: "zinc" as const };
}

const TONE_CLASSES = {
  amber: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
  green: "border-[#0ca30c]/30 bg-green-50 dark:border-[#0ca30c]/40 dark:bg-green-950/30",
  red: "border-[#d03b3b]/30 bg-red-50 dark:border-[#d03b3b]/40 dark:bg-red-950/30",
  zinc: "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900",
};

const TONE_TEXT_CLASSES = {
  amber: "text-amber-800 dark:text-amber-300",
  green: "text-[#0ca30c] dark:text-[#4ade80]",
  red: "text-[#d03b3b] dark:text-[#f87171]",
  zinc: "text-zinc-600 dark:text-zinc-400",
};

export function TicketCard({
  quantity,
  status,
  paymentStatus,
  isMine,
  reservationId,
  children,
}: TicketCardProps) {
  const { text, tone } = statusLabel(status, paymentStatus);

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 ${TONE_CLASSES[tone]}`}
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
            🎫 {quantity}매
          </span>
          {isMine && (
            <span className="rounded-full bg-zinc-950 px-2 py-0.5 text-[11px] font-medium text-zinc-50 dark:bg-zinc-50 dark:text-zinc-950">
              내 예매
            </span>
          )}
        </div>
        {reservationId !== undefined && (
          <span className="text-xs text-zinc-500 dark:text-zinc-500">예매 #{reservationId}</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-sm font-medium ${TONE_TEXT_CLASSES[tone]}`}>{text}</span>
        {children}
      </div>
    </div>
  );
}
