import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { BookingForm } from "./booking-form";
import { FakeEventSource } from "../test/fake-event-source";

function queueSource() {
  return FakeEventSource.instances.find((s) => s.url.includes("/queue/stream"));
}
function reservationSource() {
  return FakeEventSource.instances.find((s) => s.url.includes("/reservations/999/stream"));
}

// 순번 숫자를 <span>으로 감싸 텍스트가 두 노드로 나뉘어 있어(굵게 표시하려고),
// 문자열 매칭 대신 textContent를 직접 비교하는 함수 매처를 쓴다.
function findByRank(rank: number) {
  return screen.findByText(
    (_, element) => element?.textContent === `대기 중입니다 — 현재 순번 ${rank}`,
  );
}

// 대기열 입장 → 순번 → 입장 허가 → 예매하기까지는 세 테스트가 공유하는 경로라 헬퍼로 뽑는다.
async function joinQueueAndGetAdmitted() {
  await screen.findByText("내 예매 — 선착순 데모 콘서트");
  fireEvent.click(screen.getByRole("button", { name: "대기열 입장" }));
  await findByRank(0);
  act(() => queueSource()?.emit({ rank: null, admitted: true }));
  await screen.findByText("지금 예매하세요 — 수량");
}

describe("BookingForm (대기열 → 예매 → 결제, ADR 0017/0018)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    FakeEventSource.instances = [];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("대기열 입장 → 순번 표시 → 입장 허가 → 예매 → 결제 성공 시 확정 문구를 보여준다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u.includes("/pay")) return { ok: true, json: async () => ({ status: "PENDING" }) };
      if (u.includes("/reservations")) {
        return { ok: true, json: async () => ({ id: 999, status: "HELD" }) };
      }
      if (u.includes("/queue")) return { ok: true, json: async () => ({ joined: true }) };
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    render(<BookingForm eventId={1} eventTitle="선착순 데모 콘서트" />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    fireEvent.click(screen.getByRole("button", { name: "대기열 입장" }));

    await findByRank(0);
    act(() => queueSource()?.emit({ rank: 3, admitted: false }));
    await findByRank(3);

    act(() => queueSource()?.emit({ rank: null, admitted: true }));
    await screen.findByText("지금 예매하세요 — 수량");

    fireEvent.click(screen.getByRole("button", { name: "예매하기" }));
    await screen.findByText("재고를 확보했습니다(HELD) — 30초 내 결제를 완료해 주세요.");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/events/1/reservations?strategy=held"),
      expect.objectContaining({ method: "POST" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "결제하기" }));
    await screen.findByText("결제 처리 중(PENDING)... 잠시만 기다려 주세요.");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/reservations/999/pay"),
      expect.objectContaining({ method: "POST" }),
    );

    act(() => reservationSource()?.emit({ reservationId: 999, status: "CONFIRMED" }));
    await screen.findByText("결제가 완료돼 예매가 확정됐습니다.");
  });

  it("결제가 실패(CANCELLED)하면 좌석 반환 문구와 재시도 버튼을 보여준다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u.includes("/pay")) return { ok: true, json: async () => ({ status: "PENDING" }) };
      if (u.includes("/reservations")) {
        return { ok: true, json: async () => ({ id: 999, status: "HELD" }) };
      }
      if (u.includes("/queue")) return { ok: true, json: async () => ({}) };
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    render(<BookingForm eventId={1} eventTitle="선착순 데모 콘서트" />);
    await joinQueueAndGetAdmitted();

    fireEvent.click(screen.getByRole("button", { name: "예매하기" }));
    await screen.findByText("재고를 확보했습니다(HELD) — 30초 내 결제를 완료해 주세요.");

    fireEvent.click(screen.getByRole("button", { name: "결제하기" }));
    await screen.findByText("결제 처리 중(PENDING)... 잠시만 기다려 주세요.");

    act(() => reservationSource()?.emit({ reservationId: 999, status: "CANCELLED" }));

    await screen.findByText("결제에 실패해 좌석이 반환됐습니다.");
    expect(screen.getByRole("button", { name: "다시 예매하기" })).toBeInTheDocument();
  });

  it("입장 허가창을 놓치면(rank도 없고 허가도 없음) 만료 문구와 재입장 버튼을 보여준다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/queue")) return { ok: true, json: async () => ({}) };
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    render(<BookingForm eventId={1} eventTitle="선착순 데모 콘서트" />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    fireEvent.click(screen.getByRole("button", { name: "대기열 입장" }));
    await findByRank(0);

    act(() => queueSource()?.emit({ rank: null, admitted: false }));

    await screen.findByText("입장 허가 시간이 지났습니다. 다시 대기열에 입장해 주세요.");
    expect(screen.getByRole("button", { name: "다시 대기열 입장" })).toBeInTheDocument();
  });

  it("재고 부족(409) 시 에러 메시지와 재시도 버튼을 보여준다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/reservations")) {
        return { ok: false, json: async () => ({ message: "재고가 부족합니다." }) };
      }
      if (url.toString().includes("/queue")) return { ok: true, json: async () => ({}) };
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    render(<BookingForm eventId={1} eventTitle="선착순 데모 콘서트" />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    fireEvent.click(screen.getByRole("button", { name: "대기열 입장" }));
    await findByRank(0);

    act(() => queueSource()?.emit({ rank: null, admitted: true }));
    await screen.findByText("지금 예매하세요 — 수량");

    fireEvent.click(screen.getByRole("button", { name: "예매하기" }));

    await screen.findByText("재고가 부족합니다.");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  it("로그인 안 된 상태로 대기열 입장을 누르면(401) 에러 메시지를 보여준다", async () => {
    // /events/[id]가 별도 페이지로 분리되며(2026-08-06) 로그인 전에도 이 화면에
    // 올 수 있게 된 것에 대한 회귀 테스트.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/queue")) {
        return { ok: false, json: async () => ({ message: "Unauthorized" }) };
      }
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    render(<BookingForm eventId={1} eventTitle="선착순 데모 콘서트" />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    fireEvent.click(screen.getByRole("button", { name: "대기열 입장" }));

    await screen.findByText("Unauthorized");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });
});
