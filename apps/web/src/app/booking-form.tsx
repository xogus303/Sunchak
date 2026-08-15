"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, apiUrl } from "@/lib/api";
import { TicketCard } from "./ticket-card";

// 대기열 SSE 스냅샷(백엔드 QueueStatus, ADR 0017)과 모양을 맞춘다.
interface QueueSnapshot {
  rank: number | null;
  admitted: boolean;
}

interface BookingFormProps {
  eventId: number;
  eventTitle: string;
}

// "대기열 진입부터 결제·확정까지" 한 패널에서 계속 보여주는 상태 하나로 표현한다
// (화면을 갈아타지 않고 문구만 바뀜 — 2026-08-06 논의 결정).
//   idle(대기열 입장 전) → queued(대기 중, 순번) → admitted(내 차례, 수량 선택)
//   → held(관문 통과, 결제 대기) → paying(결제 요청, PENDING) → confirmed(결제 성공)
//   / cancelled(결제 실패, 좌석 반환) / expired(허가창 놓침) / error(예매 자체 실패)
// held 이후 단계는 티켓 카드로 표시하므로(2026-08-07) 카드에 필요한 quantity를
// 상태 전이 시점에 함께 실어 나른다 — 렌더 시점에 외부 입력값(qtyInput)을 다시
// 참조하면, "다시 예매하기"로 새 수량을 입력하는 동안 이전 티켓 카드의 수량까지
// 같이 바뀌어 보이는 문제가 생긴다.
type FlowState =
  | { phase: "idle" }
  | { phase: "queued"; rank: number }
  | { phase: "admitted" }
  | { phase: "held"; reservationId: number; quantity: number }
  | { phase: "paying"; reservationId: number; quantity: number }
  | { phase: "confirmed"; quantity: number }
  | { phase: "cancelled"; quantity: number }
  | { phase: "expired" }
  | { phase: "error"; message: string };

// 판매중인 이벤트로 진입했을 때만 렌더된다 — eventId/eventTitle은 호출부
// (app/events/[id]/page.tsx)가 이미 ON_SALE로 확인한 뒤 넘겨준다.
export function BookingForm({ eventId, eventTitle }: BookingFormProps) {
  // 문자열로 따로 들고 있는다 — 전부 지웠을 때 Number("")=0이 강제로 필드에
  // "0"으로 박히면서 이어 치면 "0100"처럼 붙는 문제를 피한다(demo-dashboard.tsx와 동일).
  const [qtyInput, setQtyInput] = useState("1");
  const quantity = qtyInput === "" ? 0 : Number(qtyInput);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<FlowState>({ phase: "idle" });

  // 대기열 순번/입장 허가 SSE(ADR 0017) — "예매하기"를 누르는 순간(held로 전환)
  // 이후엔 이 예매 시도 자체가 이미 서버에서 검증된 것이라 더 볼 필요가 없다.
  const isWaitingForAdmission = state.phase === "queued" || state.phase === "admitted";
  useEffect(() => {
    if (!isWaitingForAdmission) return;

    const source = new EventSource(apiUrl(`/events/${eventId}/queue/stream`), {
      withCredentials: true,
    });
    source.onmessage = (e) => {
      const snapshot = JSON.parse(e.data) as QueueSnapshot;
      if (snapshot.admitted) {
        setState((prev) => (prev.phase === "queued" ? { phase: "admitted" } : prev));
      } else if (snapshot.rank !== null) {
        setState({ phase: "queued", rank: snapshot.rank });
      } else {
        // rank도 없고 허가도 없음 = 입장 허가창을 놓쳐 밀려남.
        setState({ phase: "expired" });
      }
    };
    return () => source.close();
  }, [eventId, isWaitingForAdmission]);

  const handleJoinQueue = useCallback(async () => {
    const res = await apiFetch(`/events/${eventId}/queue`, { method: "POST" });
    if (!res.ok) {
      // /events/[id]가 별도 페이지로 분리되며(2026-08-06) 로그인 전에도 이 화면에
      // 올 수 있게 됐다 — 로그인 안 된 상태로 누르면 서버가 401을 준다.
      const body = await res.json().catch(() => null);
      setState({ phase: "error", message: body?.message ?? "대기열 입장에 실패했습니다." });
      return;
    }
    setState({ phase: "queued", rank: 0 });
  }, [eventId]);

  // 방문자가 이 이벤트를 선택하는 순간(마운트 시점) 자동으로 소규모~중간
  // 랜덤 규모(5~100명)의 가상 유저를 먼저 흘려보내 실제 경쟁 상황을 만들고,
  // 방문자 본인도 자동으로 대기열에 입장시킨다 — "버튼을 눌러야 뭔가 보인다"가
  // 아니라 들어오자마자 선착순 경쟁을 몸으로 느끼게 하려는 목적(2026-08-07).
  // 순번 자체를 조작하는 게 아니라, 경쟁 인원수를 랜덤화해서 매번 다른 순번이
  // "실제로" 부여되게 한다 — ADR 0017의 "가짜 우선순위 없음" 원칙은 그대로 유지.
  // handleJoinQueue를 그대로 호출하지 않고 fetch·then 콜백 안에서 setState하는
  // 형태로 풀어 쓴 이유 — react-hooks/set-state-in-effect 린트가 "effect 본문에서
  // setState하는 함수를 직접 호출하는 패턴"을 지적해서, "외부 이벤트(fetch 응답)에
  // 반응해 콜백에서 setState"하는 권장 형태로 맞췄다(동작은 handleJoinQueue와 동일).
  //
  // ⚠️ 두 요청을 동시에 쏘지 않고 반드시 순서대로(simulate 응답 → 그 다음 join)
  // 보낸다 — 동시에 쏘면 방문자 본인의 입장(단순 ZADD 한 번)이 가상 유저의
  // 입장(User 생성 후 ZADD, 훨씬 느림)보다 항상 먼저 끝나 크라우드 규모와
  // 무관하게 늘 0번을 받는 문제가 있었다(2026-08-07 실사용 중 발견). 백엔드도
  // auto=true일 때 최대 AUTO_JOIN_GUARANTEE_MAX(100)명 입장이 끝난 뒤에야
  // 응답하도록 맞춰뒀다.
  //
  // ⚠️ ref 가드가 필요한 이유 — Next.js App Router는 개발 모드에서 React
  // StrictMode가 기본 켜져 있어, 마운트 시 이 effect가 "일부러" 두 번 실행된다.
  // 가드 없이 두면: 1번째 실행이 크라우드 투입을 기다리는 동안, 2번째 실행의
  // simulate 요청은 3초 쿨다운에 걸려 즉시 거부(429)되고 → 기다릴 게 없으니
  // 곧바로 본인 입장을 호출해 1번째 실행의 크라우드보다 먼저 큐에 서버린다
  // (ZADD가 NX라 최초 타임스탬프만 유지 — 이 "새치기"가 영구 순번이 됨).
  // 그 결과 대기열에 수십 명이 찍혀도 본인은 항상 0번을 받는 버그가 있었다
  // (2026-08-07 실사용 중 발견). ref는 클린업으로도 안 지워지므로 두 번째
  // 실행을 확실히 막는다.
  // ⚠️ 대기열 안내 팝업(queue-notice-modal.tsx)은 이제 이 페이지가 아니라
  // 이벤트 목록(event-list.tsx)에서 "이벤트 선택 → 안내 확인 → 그제서야 이동"
  // 순서로 먼저 끝난 뒤에만 이 페이지에 도달한다(2026-08-08 재조정) — 그래서
  // 여기 도착했다는 것 자체가 이미 안내를 확인했다는 뜻이라, 이 effect는
  // 별도 게이트 없이 마운트되면 곧바로 시작해도 된다.
  const hasStartedRef = useRef(false);
  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    const crowdSize = Math.floor(Math.random() * 96) + 5; // 5~100명
    apiFetch("/demo/simulate", {
      method: "POST",
      body: JSON.stringify({ virtualUserCount: crowdSize, auto: true }),
    })
      .catch(() => {}) // 쿨다운(429) 등은 조용히 무시 — 방금 다른 방문자가 이미 투입했을 뿐
      .then(() =>
        apiFetch(`/events/${eventId}/queue`, { method: "POST" }).then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            setState({ phase: "error", message: body?.message ?? "대기열 입장에 실패했습니다." });
            return;
          }
          setState({ phase: "queued", rank: 0 });
        }),
      );
  }, [eventId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await apiFetch(`/events/${eventId}/reservations?strategy=held`, {
      method: "POST",
      body: JSON.stringify({ quantity, idempotencyKey: crypto.randomUUID() }),
    });
    setPending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setState({ phase: "error", message: body?.message ?? "예매에 실패했습니다." });
      return;
    }
    const reservation = await res.json();
    setState({ phase: "held", reservationId: reservation.id, quantity });
  }

  async function handlePay() {
    if (state.phase !== "held") return;
    const { reservationId, quantity: heldQuantity } = state;
    const res = await apiFetch(`/reservations/${reservationId}/pay`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setState({ phase: "error", message: body?.message ?? "결제 요청에 실패했습니다." });
      return;
    }
    setState({ phase: "paying", reservationId, quantity: heldQuantity });
  }

  // HELD든 결제 요청 중(paying)이든, 이 예매 하나의 최종 상태(CONFIRMED/CANCELLED)를
  // 같은 SSE로 구독한다(기존 흐름 무변경 — ADR 0018은 "누가 confirm을 일으켰든"
  // 방송 하나만 듣는다는 설계를 그대로 재사용).
  const reservationId =
    state.phase === "held" || state.phase === "paying" ? state.reservationId : null;
  const inFlightQuantity =
    state.phase === "held" || state.phase === "paying" ? state.quantity : 0;
  useEffect(() => {
    if (reservationId === null) return;
    const source = new EventSource(apiUrl(`/reservations/${reservationId}/stream`), {
      withCredentials: true,
    });
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { status: string };
      if (payload.status === "CONFIRMED") {
        setState({ phase: "confirmed", quantity: inFlightQuantity });
      } else if (payload.status === "CANCELLED") {
        setState({ phase: "cancelled", quantity: inFlightQuantity });
      }
      source.close();
    };
    return () => source.close();
  }, [reservationId, inFlightQuantity]);

  return (
    <div className="flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">내 예매 — {eventTitle}</h2>

      {state.phase === "idle" && (
        <p className="text-sm text-zinc-500">대기열 입장 중...</p>
      )}

      {state.phase === "queued" && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          대기 중입니다 — 현재 순번 <span className="font-semibold">{state.rank}</span>
        </p>
      )}

      {state.phase === "admitted" && (
        <form onSubmit={handleSubmit} className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="my-qty" className="text-sm text-zinc-600 dark:text-zinc-400">
              지금 예매하세요 — 수량
            </label>
            <input
              id="my-qty"
              type="number"
              min={1}
              value={qtyInput}
              onChange={(e) => setQtyInput(e.target.value)}
              onBlur={() => {
                if (qtyInput === "") setQtyInput("0");
              }}
              className="w-24 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>
          <button
            type="submit"
            disabled={pending || quantity < 1}
            className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {pending ? "예매 중..." : "예매하기"}
          </button>
        </form>
      )}

      {state.phase === "held" && (
        <TicketCard
          quantity={state.quantity}
          status="HELD"
          paymentStatus={null}
          isMine
          reservationId={state.reservationId}
        >
          <button
            onClick={handlePay}
            className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            결제하기
          </button>
        </TicketCard>
      )}

      {state.phase === "paying" && (
        <TicketCard
          quantity={state.quantity}
          status="HELD"
          paymentStatus="PENDING"
          isMine
          reservationId={state.reservationId}
        />
      )}

      {state.phase === "confirmed" && (
        <div className="flex flex-col gap-2">
          <TicketCard quantity={state.quantity} status="CONFIRMED" paymentStatus="PAID" isMine />
          <button
            onClick={handleJoinQueue}
            className="self-start rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            다시 예매하기
          </button>
        </div>
      )}

      {state.phase === "cancelled" && (
        <div className="flex flex-col gap-2">
          <TicketCard quantity={state.quantity} status="CANCELLED" paymentStatus="FAILED" isMine />
          <button
            onClick={handleJoinQueue}
            className="self-start rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            다시 예매하기
          </button>
        </div>
      )}

      {state.phase === "expired" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-[#d03b3b]">입장 허가 시간이 지났습니다. 다시 대기열에 입장해 주세요.</p>
          <button
            onClick={handleJoinQueue}
            className="self-start rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            다시 대기열 입장
          </button>
        </div>
      )}

      {state.phase === "error" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-[#d03b3b]">{state.message}</p>
          <button
            onClick={handleJoinQueue}
            className="self-start rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            다시 시도
          </button>
        </div>
      )}
    </div>
  );
}
