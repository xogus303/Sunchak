"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";

// 백엔드 TicketSummary(demo.service.ts)와 모양을 맞춘다 — 예매 하나하나를 티켓
// 카드로 보여주기 위한 목록(2026-08-07). isMine은 유저별 격리 덕에 안전하게
// 계산된다 — 이벤트 자체가 유저마다 따로라 다른 사람의 예매가 섞일 일이 없다.
export interface TicketSummary {
  id: number;
  quantity: number;
  status: "HELD" | "CONFIRMED" | "EXPIRED" | "CANCELLED";
  paymentStatus: "PENDING" | "PAID" | "FAILED" | null;
  isMine: boolean;
}

// 백엔드 DemoStats(demo.service.ts)와 모양을 맞춘다 — 1초 주기 SSE 스냅샷.
export interface DemoStats {
  // 게이지 시각화(2026-08-08)가 재고 게이지의 분모로 쓴다 — 리셋해도 안 바뀌는
  // 이벤트의 총 재고(inventory.totalQty).
  totalQty: number;
  remainingQty: number;
  heldCount: number;
  confirmedCount: number;
  queueBacklog: number;
  paidCount: number;
  failedCount: number;
  soldOutCount: number;
  abandonedCount: number;
  admissionQueueCount: number;
  tickets: TicketSummary[];
}

// DemoDashboard(판매현황·시뮬 컨트롤)와 TicketList(내 예매 목록, 좌측 패널)가
// 같은 스냅샷을 나눠 써야 해서(2026-08-07, 사용자 요청 — 티켓 목록을 좌측
// "내 예매" 패널 쪽으로 이동) SSE 구독을 이 훅 하나로 끌어올렸다 — 각자
// 따로 구독하면 같은 스트림에 커넥션이 2개 열려 낭비다.
export function useDemoStats() {
  const [stats, setStats] = useState<DemoStats | null>(null);
  const [streamError, setStreamError] = useState(false);

  useEffect(() => {
    const source = new EventSource(apiUrl("/demo/stats/stream"), { withCredentials: true });
    source.onmessage = (event) => {
      setStreamError(false);
      setStats(JSON.parse(event.data) as DemoStats);
    };
    source.onerror = () => setStreamError(true);
    return () => source.close();
  }, []);

  return { stats, streamError };
}
