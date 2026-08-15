"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { DemoStats } from "./use-demo-stats";

interface DemoDashboardProps {
  stats: DemoStats | null;
  streamError: boolean;
}

// 재고/대기중처럼 "지금 이 순간 판단이 필요한" 두 값만 게이지+큰 숫자로 헤드라인에
// 남긴다(2026-08-08, 사용자와 목업으로 방향 확정 — Artifact로 옵션 A 확정).
// max가 없는 값(대기중)은 표시 상한(capAt)까지만 채우고, 실제 숫자는 그대로 보여준다
// — 게이지가 "얼마나 찼는지"를, 숫자가 "정확히 몇 명인지"를 각자 맡는다.
function Gauge({
  label,
  value,
  max,
  capAt,
  tone,
  unit,
}: {
  label: string;
  value: number;
  max: number;
  capAt?: number;
  tone: "confirmed" | "waiting" | "sold";
  unit?: string;
}) {
  const scaleMax = capAt ?? max;
  const pct = scaleMax > 0 ? Math.min(100, (value / scaleMax) * 100) : 0;
  const fillClass =
    tone === "sold"
      ? "bg-[#d03b3b] dark:bg-[#f87171]"
      : tone === "waiting"
        ? "bg-indigo-500 dark:bg-indigo-400"
        : "bg-[#0ca30c] dark:bg-[#4ade80]";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">{label}</span>
        <span className="font-mono text-2xl font-bold tabular-nums text-zinc-950 dark:text-zinc-50">
          {value.toLocaleString()}
          <span className="ml-1 text-xs font-medium text-zinc-500 dark:text-zinc-500">
            {unit ?? `/ ${max}`}
          </span>
        </span>
      </div>
      <div className="h-3 overflow-hidden rounded-full border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800">
        <span className={`block h-full rounded-full ${fillClass}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between font-mono text-[10px] text-zinc-500 dark:text-zinc-500">
        <span>0</span>
        <span>{scaleMax}</span>
      </div>
      {tone === "sold" && (
        <span className="text-xs font-medium text-[#d03b3b] dark:text-[#f87171]">매진</span>
      )}
    </div>
  );
}

// 확보중(HELD) 이후 분기 결과(확정/결제실패/만료)를 퍼센티지 막대 하나로 압축.
// stats.tickets는 이 유저의 데모 이벤트에 속한 예매 전체(진행중 HELD 포함)라
// 여기서는 "이미 끝난" 것만 걸러 분모로 쓴다.
function OutcomeBar({ tickets }: { tickets: DemoStats["tickets"] }) {
  const resolved = tickets.filter((t) => t.status !== "HELD");
  const total = resolved.length;
  if (total === 0) {
    return <p className="text-sm text-zinc-500">아직 결과가 없습니다.</p>;
  }
  const confirmedN = resolved.filter((t) => t.status === "CONFIRMED").length;
  const failedN = resolved.filter((t) => t.status === "CANCELLED").length;
  const expiredN = resolved.filter((t) => t.status === "EXPIRED").length;
  const segments = [
    { n: confirmedN, cls: "bg-[#0ca30c] dark:bg-[#4ade80]" },
    { n: failedN, cls: "bg-[#d03b3b] dark:bg-[#f87171]" },
    { n: expiredN, cls: "bg-zinc-400 dark:bg-zinc-600" },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
          최종 결과(확보중 이후 분기)
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
          확정 <b className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">{confirmedN}건</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#d03b3b] dark:bg-[#f87171]" />
          결제 실패 <b className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">{failedN}건</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-zinc-400 dark:bg-zinc-600" />
          만료 <b className="font-mono font-semibold text-zinc-950 dark:text-zinc-50">{expiredN}건</b>
        </span>
      </div>
    </div>
  );
}

// 지금 당장 판단할 값(재고/대기중/최종결과)이 아니라 누적 집계 확인용 — 조용한
// 한 줄 스트립으로 내려 위 헤드라인과 시각적 위계를 분리한다.
function DetailStrip({ items }: { items: { label: string; value: number }[] }) {
  return (
    <div className="flex flex-wrap divide-x divide-zinc-200 border-t border-zinc-200 pt-4 dark:divide-zinc-800 dark:border-zinc-800">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5 px-4 first:pl-0">
          <span className="text-[11px] whitespace-nowrap text-zinc-500 dark:text-zinc-500">
            {item.label}
          </span>
          <span className="font-mono text-sm font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
            {item.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

// stats/streamError를 props로 받는다(2026-08-07) — 티켓 목록(TicketList)이
// 좌측 "내 예매" 패널로 옮겨가며 같은 SSE 스냅샷을 나눠 써야 해서, 구독 자체는
// 부모(events/[id]/page.tsx)의 useDemoStats() 훅 하나로 끌어올렸다(중복 커넥션 방지).
export function DemoDashboard({ stats, streamError }: DemoDashboardProps) {
  // 입력값을 문자열로 따로 들고 있는다 — value를 숫자로 강제하면 전부 지웠을 때
  // Number("")=0이 되어 필드에 "0"이 강제로 박히고, 그 뒤에 이어 치면 "0100"처럼
  // 붙어버린다. 빈 칸은 그대로 두고, 포커스를 벗어날 때만 "0"으로 채운다.
  const [vuInput, setVuInput] = useState("20");
  const virtualUserCount = vuInput === "" ? 0 : Number(vuInput);

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
      <div className="flex flex-col gap-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="grid grid-cols-2 gap-5">
          <Gauge
            label="재고 잔량"
            value={stats?.remainingQty ?? 0}
            max={stats?.totalQty ?? 100}
            tone={stats?.remainingQty === 0 ? "sold" : "confirmed"}
          />
          <Gauge
            label="입장 대기중"
            value={stats?.admissionQueueCount ?? 0}
            max={200}
            capAt={200}
            tone="waiting"
            unit="명"
          />
        </div>
        <OutcomeBar tickets={stats?.tickets ?? []} />
        <DetailStrip
          items={[
            { label: "확보중(HELD)", value: stats?.heldCount ?? 0 },
            { label: "결제 성공(PAID)", value: stats?.paidCount ?? 0 },
            { label: "결제 실패(FAILED)", value: stats?.failedCount ?? 0 },
            { label: "재고소진 실패", value: stats?.soldOutCount ?? 0 },
            { label: "포기(미시도)", value: stats?.abandonedCount ?? 0 },
            { label: "큐 적체", value: stats?.queueBacklog ?? 0 },
          ]}
        />
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
