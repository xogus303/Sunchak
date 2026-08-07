"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

interface EventItem {
  id: number;
  title: string;
  description: string | null;
  price: number;
  status: "UPCOMING" | "ON_SALE" | "SOLD_OUT" | "CLOSED";
}

// 상태별 라벨/색 — 판매중만 강조하고 나머지는 중립 톤(색은 실제 상태에만, 라벨 병기).
const STATUS_LABEL: Record<EventItem["status"], string> = {
  ON_SALE: "판매중",
  SOLD_OUT: "매진",
  UPCOMING: "오픈 예정",
  CLOSED: "종료",
};
const STATUS_COLOR: Record<EventItem["status"], string> = {
  ON_SALE: "text-[#0ca30c]",
  SOLD_OUT: "text-[#d03b3b]",
  UPCOMING: "text-zinc-500 dark:text-zinc-400",
  CLOSED: "text-zinc-500 dark:text-zinc-400",
};

// 이벤트가 몇 개뿐이라 목록에 제목/설명/가격/상태를 전부 보여준다(별도 상세
// 텍스트 조회 없이 카드만으로 충분 — 2026-08-06 PRD 재검토, 편리성 기준 결정).
// 판매중(ON_SALE)인 이벤트만 실제로 "진입 가능"(상세/예매 페이지로 이동) —
// 나머지(매진/오픈예정/종료)는 정적 장식(prisma/seed.ts)일 뿐 클릭 동작이 없다
// (2026-08-06 수정: 예전엔 전부 클릭 불가였는데, 이벤트 목록이 별도 페이지로
// 분리되며 "판매중인 것만 들어갈 수 있다"는 제약을 명시적으로 걸었다).
export function EventList() {
  const [events, setEvents] = useState<EventItem[] | null>(null);

  useEffect(() => {
    apiFetch("/events")
      .then((res) => res.json())
      .then((data: EventItem[]) => setEvents(data));
  }, []);

  if (!events) return null;

  return (
    <div className="flex w-full max-w-2xl flex-col gap-3">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">이벤트 목록</h2>
      <div className="flex flex-col gap-2">
        {events.map((event) => {
          const enterable = event.status === "ON_SALE";
          const card = (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-zinc-950 dark:text-zinc-50">{event.title}</span>
                {event.description && (
                  <span className="text-xs text-zinc-500 dark:text-zinc-500">{event.description}</span>
                )}
                <span className="text-xs text-zinc-600 dark:text-zinc-400">
                  {event.price.toLocaleString()}원
                </span>
              </div>
              <span className={`text-xs font-medium whitespace-nowrap ${STATUS_COLOR[event.status]}`}>
                {STATUS_LABEL[event.status]}
              </span>
            </div>
          );
          return enterable ? (
            <Link key={event.id} href={`/events/${event.id}`} className="rounded-lg hover:opacity-80">
              {card}
            </Link>
          ) : (
            <div key={event.id}>{card}</div>
          );
        })}
      </div>
    </div>
  );
}
