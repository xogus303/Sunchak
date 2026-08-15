import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DemoDashboard } from "./demo-dashboard";
import type { DemoStats, TicketSummary } from "./use-demo-stats";

// SSE 구독은 이제 부모(events/[id]/page.tsx)의 useDemoStats() 훅이 갖고 있고
// DemoDashboard는 stats/streamError를 props로만 받는다(2026-08-07, 티켓 목록이
// 좌측 TicketList로 옮겨가며 SSE 커넥션을 하나로 합침) — 그래서 이 테스트는
// EventSource를 흉내낼 필요 없이 props만 바꿔가며 렌더 결과를 확인한다.
function renderWithQuery(stats: DemoStats | null = null, streamError = false) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <DemoDashboard stats={stats} streamError={streamError} />
    </QueryClientProvider>,
  );
}

function ticket(status: TicketSummary["status"]): TicketSummary {
  return { id: Math.random(), quantity: 1, status, paymentStatus: null, isMine: true };
}

const sampleStats: DemoStats = {
  totalQty: 100,
  remainingQty: 85,
  heldCount: 0,
  confirmedCount: 15,
  queueBacklog: 0,
  paidCount: 0,
  failedCount: 0,
  soldOutCount: 3,
  abandonedCount: 2,
  admissionQueueCount: 7,
  // 확정 3 · 결제실패 2 · 만료 1(총 6건) — 서로 다른 수로 둬야 텍스트 매처가
  // 겹치지 않는다(2026-08-08, 게이지+퍼센티지 막대 도입).
  tickets: [
    ticket("CONFIRMED"),
    ticket("CONFIRMED"),
    ticket("CONFIRMED"),
    ticket("CANCELLED"),
    ticket("CANCELLED"),
    ticket("EXPIRED"),
  ],
};

// 2026-08-08 — 스탯 타일 6개 그리드를 게이지 2종(재고/대기중) + 최종결과
// 퍼센티지 막대 + 조용한 세부 수치 스트립으로 재구성(Artifact 목업으로 방향
// 확정 후 적용).
describe("DemoDashboard", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stats prop 값으로 재고·대기중 게이지를 보여준다(재고는 totalQty가 분모)", () => {
    renderWithQuery(sampleStats);

    expect(screen.getByText("재고 잔량").nextSibling).toHaveTextContent("85");
    expect(screen.getByText("재고 잔량").nextSibling).toHaveTextContent("100");
    expect(screen.getByText("입장 대기중").nextSibling).toHaveTextContent("7");
  });

  it("최종 결과를 퍼센티지 막대 + 정확한 건수로 보여준다", () => {
    renderWithQuery(sampleStats);

    expect(screen.getByText("총 6건")).toBeInTheDocument();
    expect(screen.getByText("3건")).toBeInTheDocument(); // 확정
    expect(screen.getByText("2건")).toBeInTheDocument(); // 결제 실패
    expect(screen.getByText("1건")).toBeInTheDocument(); // 만료
  });

  it("HELD만 있고 결과가 아직 없으면 안내 문구를 보여준다", () => {
    renderWithQuery({ ...sampleStats, tickets: [ticket("HELD")] });

    expect(screen.getByText("아직 결과가 없습니다.")).toBeInTheDocument();
  });

  it("세부 수치(HELD/PAID/FAILED 등)는 조용한 스트립으로 계속 보여준다", () => {
    renderWithQuery(sampleStats);

    expect(screen.getByText("재고소진 실패").nextSibling).toHaveTextContent("3");
    expect(screen.getByText("포기(미시도)").nextSibling).toHaveTextContent("2");
  });

  it("stats가 아직 없으면(null) 게이지를 0으로 보여준다", () => {
    renderWithQuery(null);

    expect(screen.getByText("재고 잔량").nextSibling).toHaveTextContent("0");
  });

  it("streamError가 true면 연결 끊김 안내를 보여준다", () => {
    renderWithQuery(sampleStats, true);

    expect(screen.getByText("실시간 연결이 끊겼습니다. 새로고침해 주세요.")).toBeInTheDocument();
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
