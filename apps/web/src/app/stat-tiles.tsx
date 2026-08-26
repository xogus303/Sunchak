"use client";

// 데모 대시보드·대량 트래픽 테스트 대시보드가 공유하는 공용 프레젠테이션
// 컴포넌트(2026-08-26, demo-dashboard.tsx에서 추출 — 두 번째 사용처가 생겨
// 중복 대신 공용화).

// 재고/대기중처럼 "지금 이 순간 판단이 필요한" 값을 게이지+큰 숫자로 보여준다.
// max가 없는 값(대기중 등)은 표시 상한(capAt)까지만 채우고, 실제 숫자는 그대로
// 보여준다 — 게이지가 "얼마나 찼는지"를, 숫자가 "정확히 몇 명인지"를 각자 맡는다.
export function Gauge({
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

// 지금 당장 판단할 값이 아니라 누적 집계 확인용 — 조용한 한 줄 스트립으로
// 내려 헤드라인(게이지 등)과 시각적 위계를 분리한다.
export function DetailStrip({ items }: { items: { label: string; value: number }[] }) {
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
