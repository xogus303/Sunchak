"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { QueueNoticeModal } from "./queue-notice-modal";

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
//
// ⚠️ 판매중 카드는 <Link>가 아니라 클릭 핸들러다(2026-08-08 재조정) — 예전엔
// 상세 페이지 마운트 시 대기열 안내 팝업을 띄웠는데, 안내를 읽는 동안 이미
// BookingForm의 자동 대기열 입장이 진행돼버려 "안내 → 실제 대기열" 체감이
// 어긋났다. 그래서 순서를 "카드 클릭 → 안내 팝업(선택된 이벤트 기억) → 확인
// → 그제서야 상세 페이지로 이동"으로 바꿔, 상세 페이지 도착 시점엔 이미
// 안내를 확인한 뒤가 되도록 했다. QueueNoticeModal이 "이미 봤음"(localStorage)
// 이면 onAcknowledged를 즉시 호출하므로, 재방문자는 클릭 즉시 바로 이동한다.
export function EventList() {
  const router = useRouter();
  const [events, setEvents] = useState<EventItem[] | null>(null);
  // 응답이 실패(401 등)여도 예전엔 그대로 res.json()의 에러 바디({message,...})를
  // "이벤트 배열"로 오해해 events.map()에서 그대로 터졌다(2026-08-08 실사용 중
  // 발견 — 세션 만료/DB 초기화로 로그인 쿠키의 유저가 실제로는 없는 상태가 되면
  // 백엔드가 500을 주는데, 프론트가 그걸 확인 안 하고 바로 배열처럼 다뤘다).
  const [error, setError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);

  useEffect(() => {
    apiFetch("/events").then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? "이벤트 목록을 불러오지 못했습니다.");
        return;
      }
      setEvents(await res.json());
    });
  }, []);

  if (error) {
    return (
      <div className="flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm text-[#d03b3b]">{error}</p>
        <Link href="/" className="text-sm text-zinc-600 underline dark:text-zinc-400">
          다시 로그인하기
        </Link>
      </div>
    );
  }

  if (!events) return null;

  return (
    <div className="flex w-full max-w-2xl flex-col gap-3">
      {selectedEventId !== null && (
        <QueueNoticeModal
          onAcknowledged={() => router.push(`/events/${selectedEventId}`)}
        />
      )}
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
            <button
              key={event.id}
              onClick={() => setSelectedEventId(event.id)}
              className="rounded-lg text-left hover:opacity-80"
            >
              {card}
            </button>
          ) : (
            <div key={event.id}>{card}</div>
          );
        })}
      </div>
    </div>
  );
}
