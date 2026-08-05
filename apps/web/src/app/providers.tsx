"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// QueryClient는 useState로 한 번만 만든다 — 매 렌더마다 새로 만들면 캐시가
// 그때그때 날아간다. staleTime/gcTime은 전역 기본값을 두지 않고, 데이터
// 성격이 다른 각 쿼리(예: 이벤트 목록 vs 데모 stats)에서 개별적으로
// 명시한다(CLAUDE.md §6 컨벤션).
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
