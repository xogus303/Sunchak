"use client";

import { useEffect, useState } from "react";
import { apiFetch, apiUrl } from "@/lib/api";

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
type FlowState =
  | { phase: "idle" }
  | { phase: "queued"; rank: number }
  | { phase: "admitted" }
  | { phase: "held"; reservationId: number }
  | { phase: "paying"; reservationId: number }
  | { phase: "confirmed" }
  | { phase: "cancelled" }
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

  async function handleJoinQueue() {
    const res = await apiFetch(`/events/${eventId}/queue`, { method: "POST" });
    if (!res.ok) {
      // /events/[id]가 별도 페이지로 분리되며(2026-08-06) 로그인 전에도 이 화면에
      // 올 수 있게 됐다 — 로그인 안 된 상태로 누르면 서버가 401을 준다.
      const body = await res.json().catch(() => null);
      setState({ phase: "error", message: body?.message ?? "대기열 입장에 실패했습니다." });
      return;
    }
    setState({ phase: "queued", rank: 0 });
  }

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
    setState({ phase: "held", reservationId: reservation.id });
  }

  async function handlePay() {
    if (state.phase !== "held") return;
    const reservationId = state.reservationId;
    const res = await apiFetch(`/reservations/${reservationId}/pay`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setState({ phase: "error", message: body?.message ?? "결제 요청에 실패했습니다." });
      return;
    }
    setState({ phase: "paying", reservationId });
  }

  // HELD든 결제 요청 중(paying)이든, 이 예매 하나의 최종 상태(CONFIRMED/CANCELLED)를
  // 같은 SSE로 구독한다(기존 흐름 무변경 — ADR 0018은 "누가 confirm을 일으켰든"
  // 방송 하나만 듣는다는 설계를 그대로 재사용).
  const reservationId =
    state.phase === "held" || state.phase === "paying" ? state.reservationId : null;
  useEffect(() => {
    if (reservationId === null) return;
    const source = new EventSource(apiUrl(`/reservations/${reservationId}/stream`), {
      withCredentials: true,
    });
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { status: string };
      if (payload.status === "CONFIRMED") {
        setState({ phase: "confirmed" });
      } else if (payload.status === "CANCELLED") {
        setState({ phase: "cancelled" });
      }
      source.close();
    };
    return () => source.close();
  }, [reservationId]);

  return (
    <div className="flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">내 예매 — {eventTitle}</h2>

      {state.phase === "idle" && (
        <button
          onClick={handleJoinQueue}
          className="self-start rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          대기열 입장
        </button>
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
        <div className="flex items-center gap-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            재고를 확보했습니다(HELD) — 30초 내 결제를 완료해 주세요.
          </p>
          <button
            onClick={handlePay}
            className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            결제하기
          </button>
        </div>
      )}

      {state.phase === "paying" && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">결제 처리 중(PENDING)... 잠시만 기다려 주세요.</p>
      )}

      {state.phase === "confirmed" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-[#0ca30c]">결제가 완료돼 예매가 확정됐습니다.</p>
          <button
            onClick={() => setState({ phase: "idle" })}
            className="self-start rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            다시 예매하기
          </button>
        </div>
      )}

      {state.phase === "cancelled" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-[#d03b3b]">결제에 실패해 좌석이 반환됐습니다.</p>
          <button
            onClick={() => setState({ phase: "idle" })}
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
            onClick={() => setState({ phase: "idle" })}
            className="self-start rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            다시 시도
          </button>
        </div>
      )}
    </div>
  );
}
