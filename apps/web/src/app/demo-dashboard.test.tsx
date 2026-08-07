import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DemoDashboard } from "./demo-dashboard";
import { FakeEventSource } from "../test/fake-event-source";

function renderWithQuery() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <DemoDashboard />
    </QueryClientProvider>,
  );
}

describe("DemoDashboard", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    FakeEventSource.instances = [];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SSE로 받은 스냅샷으로 스탯 타일을 실시간 갱신한다", async () => {
    renderWithQuery();
    expect(screen.getByText("재고 잔량").nextSibling).toHaveTextContent("0");

    const source = FakeEventSource.instances.find((s) => s.url.includes("/demo/stats/stream"));
    act(() => {
      source?.emit({
        remainingQty: 85,
        heldCount: 0,
        confirmedCount: 15,
        queueBacklog: 0,
        paidCount: 0,
        failedCount: 0,
        soldOutCount: 3,
        abandonedCount: 2,
        admissionQueueCount: 7,
      });
    });

    await waitFor(() => expect(screen.getByText("재고 잔량").nextSibling).toHaveTextContent("85"));
    expect(screen.getByText("확정(CONFIRMED)").nextSibling).toHaveTextContent("15");
    expect(screen.getByText("재고소진 실패").nextSibling).toHaveTextContent("3");
    expect(screen.getByText("포기(미시도)").nextSibling).toHaveTextContent("2");
    expect(screen.getByText("입장 대기중").nextSibling).toHaveTextContent("7");
  });

  it("가상 유저 투입 버튼을 누르면 입력한 인원수로 시뮬레이션을 요청한다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/demo/simulate")) {
        return { ok: true, json: async () => ({ accepted: 15 }) };
      }
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    renderWithQuery();

    fireEvent.change(screen.getByLabelText("투입할 가상 유저 수"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "가상 유저 투입" }));

    await screen.findByText("15명 투입 접수됨 — 위 스탯이 실시간으로 반영됩니다.");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/demo/simulate"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ virtualUserCount: 15 }) }),
    );
    // 연달아 같은 수를 또 누르는 실수를 막기 위해 클릭 즉시 입력값을 비운다(2026-08-06).
    expect(screen.getByLabelText("투입할 가상 유저 수")).toHaveValue(0);
  });

  it("시뮬레이션 요청이 실패하면(쿨다운 등) 에러 메시지를 보여준다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/demo/simulate")) {
        return { ok: false, json: async () => ({ message: "쿨다운 중입니다." }) };
      }
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    renderWithQuery();

    fireEvent.click(screen.getByRole("button", { name: "가상 유저 투입" }));

    await screen.findByText("쿨다운 중입니다.");
  });

  it("데이터 리셋 버튼을 누르면 POST /demo/reset을 호출하고 성공 문구를 보여준다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/demo/reset")) {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    renderWithQuery();

    fireEvent.click(screen.getByRole("button", { name: "데이터 리셋" }));

    await screen.findByText("재고·예매 데이터가 초기 상태로 리셋됐습니다.");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/demo/reset"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
