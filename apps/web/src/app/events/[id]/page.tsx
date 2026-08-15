"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { BookingForm } from "../../booking-form";
import { DemoDashboard } from "../../demo-dashboard";
import { TicketList } from "../../ticket-list";
import { useDemoStats } from "../../use-demo-stats";

interface EventDetail {
  id: number;
  title: string;
  description: string | null;
  price: number;
  status: "UPCOMING" | "ON_SALE" | "SOLD_OUT" | "CLOSED";
}

// 판매중(ON_SALE)인 이벤트만 예매 화면까지 들어갈 수 있다 — 목록(event-list.tsx)
// 에서는 판매중이 아닌 카드에 링크를 안 달아 못 들어오지만, URL을 직접 입력해
// 들어올 수도 있으니 여기서 한 번 더 막는다(2026-08-06).
// 예매(BookingForm)와 판매현황·가상유저투입(DemoDashboard)을 한 페이지에 같이
// 둔다 — 방문자가 자기 예매를 직접 눌러보면서 동시에 그 결과(재고·큐 적체 등)를
// 지켜볼 수 있어야 테스트가 의미 있다는 사용자 피드백으로 분리했던 걸 다시 합침
// (2026-08-06, 이벤트가 하나뿐인 데모 특성상 stats도 사실상 이 이벤트 전용이다).
// 넓은 화면에서는 좌우 패널로 나란히 배치(2026-08-07) — 내 예매 진행 상황과
// 판매 현황을 동시에 눈으로 좇을 수 있게.
// 좌측 = "내 예매"(BookingForm) + 그 아래 티켓 목록(TicketList, 내 티켓이 상단
// 별도 섹션), 우측 = 판매현황·가상유저투입(DemoDashboard) — 티켓 목록을
// 원래 우측에 뒀더니 "내 예매"와 물리적으로 멀어 눈에 안 띈다는 사용자
// 피드백으로 좌측으로 옮겼다(2026-08-07). stats SSE 구독은 `useDemoStats()`
// 훅으로 여기서 한 번만 열고 두 컴포넌트에 값만 내려준다(커넥션 중복 방지).
// ⚠️ 대기열 안내 팝업은 여기 없다 — 이벤트 목록(event-list.tsx)에서 "선택 →
// 안내 확인 → 이동" 순서로 먼저 끝낸 뒤에만 이 페이지에 도달한다(2026-08-08
// 재조정 — 원래 이 페이지 마운트 시 안내를 띄웠는데, 안내를 읽는 동안 이미
// BookingForm의 자동 대기열 입장이 진행돼버려 크라우드가 다 빠지는 문제가 있었다).
export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  const [event, setEvent] = useState<EventDetail | null | "not-found">(null);
  const { stats, streamError } = useDemoStats();

  useEffect(() => {
    apiFetch(`/events/${params.id}`).then(async (res) => {
      if (!res.ok) {
        setEvent("not-found");
        return;
      }
      setEvent(await res.json());
    });
  }, [params.id]);

  return (
    <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-16 dark:bg-black">
      <Link href="/events" className="self-start text-sm text-zinc-500 hover:underline dark:text-zinc-400">
        ← 이벤트 목록으로
      </Link>

      {event === null && <p className="text-sm text-zinc-500">불러오는 중...</p>}

      {event === "not-found" && (
        <p className="text-sm text-[#d03b3b]">이벤트를 찾을 수 없습니다.</p>
      )}

      {event !== null && event !== "not-found" && event.status !== "ON_SALE" && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {event.title}은(는) 지금 판매중이 아닙니다.
        </p>
      )}

      {event !== null && event !== "not-found" && event.status === "ON_SALE" && (
        <div className="flex w-full max-w-5xl flex-col items-center gap-6 lg:flex-row lg:items-start lg:justify-center">
          <div className="flex w-full max-w-2xl flex-col items-center gap-6">
            <BookingForm eventId={event.id} eventTitle={event.title} />
            <TicketList tickets={stats?.tickets ?? []} />
          </div>
          <DemoDashboard stats={stats} streamError={streamError} />
        </div>
      )}
    </div>
  );
}
