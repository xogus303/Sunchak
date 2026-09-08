"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";

// 백엔드 LoadTestStats(load-test.service.ts)와 모양을 맞춘다 — 1초 주기 SSE
// 스냅샷. 캐주얼 데모(DemoStats)와 달리 tickets(개별 예매 목록)은 없다 — 재고·
// VU가 최대 10,000까지 가능해 매초 전체 목록을 실어 보내면 부하가 크다
// (2026-08-26, 사용자와 논의해 집계 숫자만 노출하기로 확정).
export interface LoadTestStats {
  totalQty: number;
  remainingQty: number;
  heldCount: number;
  confirmedCount: number;
  queueBacklog: number;
  paidCount: number;
  failedCount: number;
  soldOutCount: number;
  abandonedCount: number;
  systemErrorCount: number;
  admissionQueueCount: number;
  pendingInjectionCount: number;
}

// useDemoStats()와 같은 구조(EventSource 구독) — 엔드포인트와 타입만 다르다.
export function useLoadTestStats() {
  const [stats, setStats] = useState<LoadTestStats | null>(null);
  const [streamError, setStreamError] = useState(false);

  useEffect(() => {
    const source = new EventSource(apiUrl("/load-test/stats/stream"), { withCredentials: true });
    source.onmessage = (event) => {
      setStreamError(false);
      setStats(JSON.parse(event.data) as LoadTestStats);
    };
    source.onerror = () => setStreamError(true);
    return () => source.close();
  }, []);

  return { stats, streamError };
}
