"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { LoadTestStats } from "./use-load-test-stats";
import { Gauge, DetailStrip } from "./stat-tiles";

interface LoadTestDashboardProps {
  stats: LoadTestStats | null;
  streamError: boolean;
  // booking-form.tsx의 sectionLabel과 같은 목적 — /load-test 페이지가 좌우를
  // "나의 상황"/"전체 현황"으로 구획할 때 붙인다(2026-08-26, UI 개선 옵션 B).
  sectionLabel?: string;
}

// 캐주얼 데모의 OutcomeBar(ticket 목록 기반)와 달리, 대량 테스트는 개별 예매
// 목록이 없어(use-load-test-stats.ts 주석 참고) 집계 숫자를 곧바로 분모로
// 쓴다 — 이 카운터들의 합이 "투입된 가상 유저 수"와 일치하는 것은 이미
// 백엔드에서 실측 검증된 불변식이다(2026-08-25 e2e, STATUS.md 참고).
// systemError(2026-08-31 추가) — DB 커넥션 풀 타임아웃 등 "결제 실패"도
// "포기"도 아닌 시스템 레벨 오류. 예전엔 이런 실패가 어떤 카운터에도 안
// 잡혀 이 불변식이 깨지고 화면에 설명 안 되는 유령 인원이 생겼다.
function AttemptOutcomeBar({
  paid,
  failed,
  soldOut,
  abandoned,
  systemError,
}: {
  paid: number;
  failed: number;
  soldOut: number;
  abandoned: number;
  systemError: number;
}) {
  const total = paid + failed + soldOut + abandoned + systemError;
  if (total === 0) {
    return <p className="text-sm text-zinc-500">아직 결과가 없습니다.</p>;
  }
  const segments = [
    { n: paid, cls: "bg-[#0ca30c] dark:bg-[#4ade80]" },
    { n: failed, cls: "bg-[#d03b3b] dark:bg-[#f87171]" },
    { n: soldOut, cls: "bg-zinc-400 dark:bg-zinc-600" },
    { n: abandoned, cls: "bg-indigo-400 dark:bg-indigo-500" },
    { n: systemError, cls: "bg-amber-400 dark:bg-amber-500" },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
          최종 결과(예매 시도 이후 분기)
        </span>
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-500">총 {total}건</span>
      </div>
      <div className="flex h-7 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700">
        {segments.map(
          ({ n, cls }, i) =>
            n > 0 && (
              <span
                key={i}
                className={`flex items-center justify-center font-mono text-[11px] font-semibold text-white dark:text-zinc-950 ${cls}`}
                style={{ width: `${(n / total) * 100}%` }}
              >
                {n / total >= 0.12 ? `${Math.round((n / total) * 100)}%` : ""}
              </span>
            ),
        )}
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-zinc-600 dark:text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#0ca30c] dark:bg-[#4ade80]" />
          확정 <b className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">{paid}건</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#d03b3b] dark:bg-[#f87171]" />
          결제 실패 <b className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">{failed}건</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-zinc-400 dark:bg-zinc-600" />
          재고소진 <b className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">{soldOut}건</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-indigo-400 dark:bg-indigo-500" />
          포기 <b className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">{abandoned}건</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-amber-400 dark:bg-amber-500" />
          시스템 오류 <b className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">{systemError}건</b>
        </span>
      </div>
    </div>
  );
}

export function LoadTestDashboard({ stats, streamError, sectionLabel }: LoadTestDashboardProps) {
  // 문자열로 따로 들고 있는 이유는 demo-dashboard.tsx의 vuInput과 같다(빈 칸
  // 처리·이어치기 버그 방지).
  // load-test/page.tsx의 자동 세팅(재고 1만·가상 유저 5천, 2026-08-26)과
  // 같은 기본값 — 수동으로 다시 조정할 때도 "대용량" 규모가 기본으로 보이게.
  const [stockInput, setStockInput] = useState("10000");
  const [vuInput, setVuInput] = useState("5000");
  const totalQty = stockInput === "" ? 0 : Number(stockInput);
  const virtualUserCount = vuInput === "" ? 0 : Number(vuInput);

  const reset = useMutation({
    mutationFn: async (qty: number) => {
      const res = await apiFetch("/load-test/reset", {
        method: "POST",
        body: JSON.stringify({ totalQty: qty }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "리셋 요청에 실패했습니다.");
      }
      return res.json();
    },
  });

  const simulate = useMutation({
    mutationFn: async (count: number) => {
      const res = await apiFetch("/load-test/simulate", {
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

  return (
    <div className="flex w-full max-w-2xl flex-col gap-3">
      {sectionLabel && (
        <div className="flex items-center gap-2">
          <span className="h-4 w-1 rounded-sm bg-zinc-950 dark:bg-zinc-50" />
          <span className="text-xs font-bold tracking-wide text-zinc-950 uppercase dark:text-zinc-50">
            {sectionLabel}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <Gauge
          label="재고 잔량"
          value={stats?.remainingQty ?? 0}
          max={stats?.totalQty ?? 1000}
          tone={stats?.remainingQty === 0 ? "sold" : "confirmed"}
        />
        <AttemptOutcomeBar
          paid={stats?.paidCount ?? 0}
          failed={stats?.failedCount ?? 0}
          soldOut={stats?.soldOutCount ?? 0}
          abandoned={stats?.abandonedCount ?? 0}
          systemError={stats?.systemErrorCount ?? 0}
        />
        <DetailStrip
          items={[
            { label: "투입 대기중", value: stats?.pendingInjectionCount ?? 0 },
            { label: "확보중(HELD)", value: stats?.heldCount ?? 0 },
            { label: "입장 대기중", value: stats?.admissionQueueCount ?? 0 },
            { label: "확정 큐 적체", value: stats?.queueBacklog ?? 0 },
          ]}
        />
      </div>
      {streamError && (
        <p className="text-sm text-red-600 dark:text-red-400">
          실시간 연결이 끊겼습니다. 새로고침해 주세요.
        </p>
      )}

      <div className="flex flex-col gap-3">
        <span className="text-[11px] font-semibold tracking-wide text-zinc-400 uppercase dark:text-zinc-500">
          관리자 설정 (선택 사항 — 이미 자동으로 세팅되어 있습니다)
        </span>
        <div className="flex flex-col gap-4 rounded-lg border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="stock-count" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              재고 수량
            </label>
            <input
              id="stock-count"
              type="number"
              min={1}
              value={stockInput}
              onChange={(e) => setStockInput(e.target.value)}
              onBlur={() => {
                if (stockInput === "") setStockInput("0");
              }}
              className="w-32 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>
          <button
            onClick={() => reset.mutate(totalQty)}
            disabled={reset.isPending || totalQty < 1}
            className="rounded-full border border-zinc-300 px-5 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {reset.isPending ? "리셋 중..." : "재고 리셋"}
          </button>
        </div>
        {reset.isError && (
          <p className="text-sm text-red-600 dark:text-red-400">{(reset.error as Error).message}</p>
        )}
        {reset.isSuccess && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            재고가 {totalQty.toLocaleString()}개로 리셋됐습니다.
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
              setVuInput("0");
            }}
            disabled={simulate.isPending || virtualUserCount < 1}
            className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {simulate.isPending ? "투입 중..." : "가상 유저 투입"}
          </button>
        </div>
        {simulate.isError && (
          <p className="text-sm text-red-600 dark:text-red-400">{(simulate.error as Error).message}</p>
        )}
        {simulate.isSuccess && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {simulate.data.accepted.toLocaleString()}명 투입 접수됨 — 위 스탯이 실시간으로 반영됩니다.
          </p>
        )}
        </div>
      </div>
    </div>
  );
}
