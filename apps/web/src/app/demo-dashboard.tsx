"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch, apiUrl } from "@/lib/api";

// 백엔드 DemoStats(demo.service.ts)와 모양을 맞춘다 — 1초 주기 SSE 스냅샷.
// paidCount/failedCount: 관리자용 "판매 현황"이 이 화면과 실질적으로 같다고 판단해
// 별도 화면 없이 여기 통합했다(2026-08-06 PRD 재검토).
interface DemoStats {
  remainingQty: number;
  heldCount: number;
  confirmedCount: number;
  queueBacklog: number;
  paidCount: number;
  failedCount: number;
  // 재고 소진으로 예매 자체가 막힌 시도 수(결제 실패와는 다른 지표 — 결제
  // 단계에 도달하지도 못했다). "결제 실패가 왜 안 늘지?" 혼란 방지용으로 추가.
  soldOutCount: number;
  // 입장 허가를 받고도 예매를 시도하지 않고 나간 가상 유저 수 — 안 보여주면
  // "투입 인원수 = soldOut+paid+failed+held 합"이 안 맞아 혼란스럽다.
  abandonedCount: number;
  // 입장 대기열에서 아직 허가를 못 받고 대기 중인 인원 수(queueBacklog와는
  // 완전히 다른 큐다 — 저건 BullMQ confirm 큐, 이건 ADR 0017 입장 대기열).
  admissionQueueCount: number;
}

// dataviz 스킬: "핸드풀한 헤드라인 숫자" → KPI row(스탯 타일). 색은 텍스트가
// 아니라 상태(재고 소진)에만 쓰고, 그때도 색 단독이 아니라 "매진" 라벨을 함께 붙인다.
function StatTile({ label, value, sold }: { label: string; value: number; sold?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <span className="text-sm text-zinc-600 dark:text-zinc-400">{label}</span>
      <span
        className={`text-3xl font-semibold ${sold ? "text-[#d03b3b]" : "text-zinc-950 dark:text-zinc-50"}`}
      >
        {value.toLocaleString()}
      </span>
      {sold && <span className="text-xs font-medium text-[#d03b3b]">매진</span>}
    </div>
  );
}

export function DemoDashboard() {
  const [stats, setStats] = useState<DemoStats | null>(null);
  const [streamError, setStreamError] = useState(false);
  // 입력값을 문자열로 따로 들고 있는다 — value를 숫자로 강제하면 전부 지웠을 때
  // Number("")=0이 되어 필드에 "0"이 강제로 박히고, 그 뒤에 이어 치면 "0100"처럼
  // 붙어버린다. 빈 칸은 그대로 두고, 포커스를 벗어날 때만 "0"으로 채운다.
  const [vuInput, setVuInput] = useState("20");
  const virtualUserCount = vuInput === "" ? 0 : Number(vuInput);

  useEffect(() => {
    const source = new EventSource(apiUrl("/demo/stats/stream"), { withCredentials: true });
    source.onmessage = (event) => {
      setStreamError(false);
      setStats(JSON.parse(event.data) as DemoStats);
    };
    source.onerror = () => setStreamError(true);
    return () => source.close();
  }, []);

  const simulate = useMutation({
    mutationFn: async (count: number) => {
      const res = await apiFetch("/demo/simulate", {
        method: "POST",
        body: JSON.stringify({ virtualUserCount: count }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "시뮬레이션 요청에 실패했습니다.");
      }
      return res.json() as Promise<{ accepted: number }>;
    },
  });

  // 백엔드 POST /demo/reset은 처음부터 있었지만(ADR 0016) 누를 UI가 없었다
  // (2026-08-06 실사용 중 발견 — 재고가 소진돼도 되돌릴 방법이 화면에 없었음).
  const reset = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/demo/reset", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "리셋에 실패했습니다.");
      }
      return res.json();
    },
  });

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">실시간 판매 현황</h2>
        <button
          onClick={() => reset.mutate()}
          disabled={reset.isPending}
          className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {reset.isPending ? "초기화 중..." : "데이터 리셋"}
        </button>
      </div>
      {reset.isError && (
        <p className="text-sm text-red-600 dark:text-red-400">{(reset.error as Error).message}</p>
      )}
      {reset.isSuccess && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          재고·예매 데이터가 초기 상태로 리셋됐습니다.
        </p>
      )}
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="재고 잔량" value={stats?.remainingQty ?? 0} sold={stats?.remainingQty === 0} />
          <StatTile label="확보중(HELD)" value={stats?.heldCount ?? 0} />
          <StatTile label="확정(CONFIRMED)" value={stats?.confirmedCount ?? 0} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="결제 성공(PAID)" value={stats?.paidCount ?? 0} />
          <StatTile label="결제 실패(FAILED)" value={stats?.failedCount ?? 0} />
          <StatTile label="포기(미시도)" value={stats?.abandonedCount ?? 0} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="재고소진 실패" value={stats?.soldOutCount ?? 0} />
          <StatTile label="큐 적체" value={stats?.queueBacklog ?? 0} />
        </div>
      </div>
      {streamError && (
        <p className="text-sm text-red-600 dark:text-red-400">
          실시간 연결이 끊겼습니다. 새로고침해 주세요.
        </p>
      )}

      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="vu-count" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            투입할 가상 유저 수
          </label>
          <input
            id="vu-count"
            type="number"
            min={1}
            value={vuInput}
            onChange={(e) => setVuInput(e.target.value)}
            onBlur={() => {
              if (vuInput === "") setVuInput("0");
            }}
            className="w-32 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>
        <button
          onClick={() => {
            simulate.mutate(virtualUserCount);
            // 클릭 즉시 입력값을 비워 다음 투입 수를 새로 입력하게 한다(연달아
            // 같은 수를 또 누르는 실수 방지 — 2026-08-06 사용자 요청).
            setVuInput("0");
          }}
          disabled={simulate.isPending || virtualUserCount < 1}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {simulate.isPending ? "투입 중..." : "가상 유저 투입"}
        </button>
        <span className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          <span>입장 대기중</span>
          <span className="font-semibold text-zinc-950 dark:text-zinc-50">
            {stats?.admissionQueueCount ?? 0}
          </span>
        </span>
      </div>
      {simulate.isError && (
        <p className="text-sm text-red-600 dark:text-red-400">{(simulate.error as Error).message}</p>
      )}
      {simulate.isSuccess && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {simulate.data.accepted}명 투입 접수됨 — 위 스탯이 실시간으로 반영됩니다.
        </p>
      )}
    </div>
  );
}
