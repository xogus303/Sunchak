import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoadTestDashboard } from "./load-test-dashboard";
import type { LoadTestStats } from "./use-load-test-stats";

// demo-dashboard.test.tsx와 같은 구조 — SSE 구독은 상위(load-test/page.tsx)의
// useLoadTestStats() 훅이 갖고 있어, 이 테스트는 stats/streamError props만
// 바꿔가며 렌더 결과를 확인한다.
function renderWithQuery(stats: LoadTestStats | null = null, streamError = false) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <LoadTestDashboard stats={stats} streamError={streamError} />
    </QueryClientProvider>,
  );
}

const sampleStats: LoadTestStats = {
  totalQty: 1000,
  remainingQty: 400,
  heldCount: 20,
  confirmedCount: 300,
  queueBacklog: 5,
  paidCount: 300,
  failedCount: 80,
  soldOutCount: 150,
  abandonedCount: 70,
  systemErrorCount: 10,
  admissionQueueCount: 60,
  pendingInjectionCount: 40,
};

describe("LoadTestDashboard", () => {
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

  it("stats prop 값으로 재고 게이지를 보여준다(totalQty가 분모)", () => {
    renderWithQuery(sampleStats);

    expect(screen.getByText("재고 잔량").nextSibling).toHaveTextContent("400");
    expect(screen.getByText("재고 잔량").nextSibling).toHaveTextContent("1000");
  });

  it("최종 결과를 확정/결제실패/재고소진/포기/시스템오류 5분할 막대로 보여준다(개별 예매 목록 없이 집계값만)", () => {
    renderWithQuery(sampleStats);

    // 300+80+150+70+10 = 610건
    expect(screen.getByText("총 610건")).toBeInTheDocument();
    expect(screen.getByText("300건")).toBeInTheDocument();
    expect(screen.getByText("80건")).toBeInTheDocument();
    expect(screen.getByText("150건")).toBeInTheDocument();
    expect(screen.getByText("70건")).toBeInTheDocument();
    expect(screen.getByText("10건")).toBeInTheDocument();
  });

  it("아직 결과가 없으면(집계 5종 모두 0) 안내 문구를 보여준다", () => {
    renderWithQuery({
      ...sampleStats,
      paidCount: 0,
      failedCount: 0,
      soldOutCount: 0,
      abandonedCount: 0,
      systemErrorCount: 0,
    });

    expect(screen.getByText("아직 결과가 없습니다.")).toBeInTheDocument();
  });

  it("세부 수치(투입대기중/확보중/입장대기중/큐적체)는 조용한 스트립으로 보여준다", () => {
    renderWithQuery(sampleStats);

    expect(screen.getByText("투입 대기중").nextSibling).toHaveTextContent("40");
    expect(screen.getByText("확보중(HELD)").nextSibling).toHaveTextContent("20");
    expect(screen.getByText("입장 대기중").nextSibling).toHaveTextContent("60");
    expect(screen.getByText("확정 큐 적체").nextSibling).toHaveTextContent("5");
  });

  it("stats가 아직 없으면(null) 게이지를 0으로 보여준다", () => {
    renderWithQuery(null);

    expect(screen.getByText("재고 잔량").nextSibling).toHaveTextContent("0");
  });

  it("streamError가 true면 연결 끊김 안내를 보여준다", () => {
    renderWithQuery(sampleStats, true);

    expect(screen.getByText("실시간 연결이 끊겼습니다. 새로고침해 주세요.")).toBeInTheDocument();
  });

  it("재고 리셋 버튼을 누르면 입력한 수량으로 POST /load-test/reset을 호출한다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/load-test/reset")) {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    renderWithQuery();

    fireEvent.change(screen.getByLabelText("재고 수량"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "재고 리셋" }));

    await screen.findByText("재고가 500개로 리셋됐습니다.");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/load-test/reset"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ totalQty: 500 }) }),
    );
  });

  it("가상 유저 투입 버튼을 누르면 입력한 인원수로 POST /load-test/simulate를 호출한다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/load-test/simulate")) {
        return { ok: true, json: async () => ({ accepted: 300 }) };
      }
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    renderWithQuery();

    fireEvent.change(screen.getByLabelText("투입할 가상 유저 수"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "가상 유저 투입" }));

    await screen.findByText("300명 투입 접수됨 — 위 스탯이 실시간으로 반영됩니다.");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/load-test/simulate"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ virtualUserCount: 300 }) }),
    );
    // 연달아 같은 수를 또 누르는 실수를 막기 위해 클릭 즉시 입력값을 비운다(demo-dashboard.tsx와 같은 이유).
    expect(screen.getByLabelText("투입할 가상 유저 수")).toHaveValue(0);
  });

  it("상한(LOAD_TEST_MAX_VU) 초과 등 시뮬레이션 요청이 실패하면 에러 메시지를 보여준다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/load-test/simulate")) {
        return { ok: false, json: async () => ({ message: "가상 유저 수는 최대 10000명까지 가능합니다." }) };
      }
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    renderWithQuery();

    fireEvent.click(screen.getByRole("button", { name: "가상 유저 투입" }));

    await screen.findByText("가상 유저 수는 최대 10000명까지 가능합니다.");
  });
});
