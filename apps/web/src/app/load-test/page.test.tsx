import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeEventSource } from "../../test/fake-event-source";

// BookingForm이 게이트/로그인 만료 시 router.push("/")로 돌려보내는 버튼을
// 렌더하므로 useRouter가 필요하다(2026-08-27).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import LoadTestPage from "./page";

// 마운트 시 자동으로 재고 1만 → 가상 유저 5천 명을 순서대로 세팅한다(2026-08-26,
// 사용자 확정) — "내 예매"(BookingForm)가 대기열에 들어가기 전에 ① 리셋이
// 먼저 끝나야 하고(안 그러면 리셋의 purge가 방금 들어간 본인 순번까지 지운다),
// ② 대기열이 충분히 쌓여야 한다(순번이 45처럼 작게 나와 "대용량" 체감이 안
// 된다는 피드백 — QUEUE_BUILDUP_THRESHOLD/TIMEOUT 참고).
//
// LoadTestDashboard가 useMutation(TanStack Query)을 쓰므로 QueryClientProvider
// 필요(events/[id]/page.test.tsx와 같은 이유).
function renderPage(children = <LoadTestPage />) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function statsSource() {
  return FakeEventSource.instances.find((s) => s.url.includes("/load-test/stats/stream"));
}

function baseFetchMock() {
  return async (u: string) => {
    const url = u.toString();
    if (url.includes("/load-test/reset")) return { ok: true, json: async () => ({}) };
    if (url.includes("/load-test/simulate")) return { ok: true, json: async () => ({ accepted: 5000 }) };
    if (url.includes("/load-test/queue")) return { ok: true, json: async () => ({ eventId: 42 }) };
    throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
  };
}

describe("LoadTestPage (자동 세팅: 재고 1만 → 가상 유저 5천 → 대기열 형성 후 본인 참여)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(baseFetchMock());
    FakeEventSource.instances = [];
    vi.stubGlobal("fetch", fetchMock);
    // useLoadTestStats()의 SSE 구독 + BookingForm의 대기열 상태 SSE 구독 둘 다 필요.
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("마운트 시 재고를 1만으로 리셋한 뒤 가상 유저 5천 명을 투입한다(순서대로)", async () => {
    renderPage();

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/load-test/reset"),
        expect.objectContaining({ method: "POST", body: JSON.stringify({ totalQty: 10000 }) }),
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/load-test/simulate"),
        expect.objectContaining({ method: "POST", body: JSON.stringify({ virtualUserCount: 5000 }) }),
      ),
    );

    // 리셋이 시뮬레이션보다 먼저 나가야 한다(호출 순서).
    const resetIdx = fetchMock.mock.calls.findIndex(([u]) => u.toString().includes("/load-test/reset"));
    const simulateIdx = fetchMock.mock.calls.findIndex(([u]) => u.toString().includes("/load-test/simulate"));
    expect(resetIdx).toBeLessThan(simulateIdx);
  });

  it("리셋이 끝난 뒤엔 대기 인원 수가 실시간으로 표시되고, 아직 본인은 참여하지 않는다", async () => {
    let resolveReset!: () => void;
    fetchMock.mockImplementation(async (u: string) => {
      const url = u.toString();
      if (url.includes("/load-test/reset")) {
        return new Promise((resolve) => {
          resolveReset = () => resolve({ ok: true, json: async () => ({}) });
        });
      }
      return baseFetchMock()(url);
    });

    renderPage();

    // "대기열 형성 중 — 현재 " + <span>0</span> + "명 대기 중"으로 텍스트가
    // 여러 노드에 걸쳐 있어(카운터를 강조하려고), 정확한 조합 문자열로 매칭한다
    // (booking-form.test.tsx의 findByRank와 같은 이유).
    await screen.findByText((_, el) => el?.textContent === "대기열 형성 중 — 현재 0명 대기 중");
    expect(screen.queryByText(/대기 중입니다|지금 예매하세요/)).not.toBeInTheDocument();

    resolveReset();
    await waitFor(() => expect(statsSource()).toBeDefined());
    act(() => statsSource()?.emit({ admissionQueueCount: 230 }));

    // 아직 임계치(600) 미만이라 계속 "형성 중" — 숫자만 갱신된다.
    await screen.findByText((_, el) => el?.textContent === "대기열 형성 중 — 현재 230명 대기 중");
    expect(screen.queryByText(/대기 중입니다|지금 예매하세요/)).not.toBeInTheDocument();
  });

  it("대기열이 임계치(600)를 넘으면 그제서야 본인을 대기열에 참여시킨다", async () => {
    renderPage();

    await waitFor(() => expect(statsSource()).toBeDefined());
    act(() => statsSource()?.emit({ admissionQueueCount: 599 }));
    expect(screen.queryByText(/대기 중입니다|지금 예매하세요/)).not.toBeInTheDocument();

    act(() => statsSource()?.emit({ admissionQueueCount: 600 }));
    await screen.findByText((_, el) => el?.textContent === "대기 중입니다 — 현재 순번 0");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/load-test/queue"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("대기열이 임계치에 못 미쳐도 타임아웃이 지나면 본인을 참여시킨다(안전장치)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage();

    // 타임아웃 타이머는 리셋이 끝난 뒤(resetDone)에만 시작된다 — simulate
    // 호출이 나갔다는 게 곧 그 시점의 증거다(리셋 완료 후에만 나가므로).
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/load-test/simulate"), expect.anything()),
    );
    await vi.waitFor(() => expect(statsSource()).toBeDefined());
    act(() => statsSource()?.emit({ admissionQueueCount: 10 })); // 임계치에 한참 못 미침

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    await vi.waitFor(() =>
      expect(screen.getByText((_, el) => el?.textContent === "대기 중입니다 — 현재 순번 0")).toBeInTheDocument(),
    );
  });

  it("StrictMode로 두 번 마운트돼도 리셋 요청은 한 번만 나간다", async () => {
    renderPage(
      <StrictMode>
        <LoadTestPage />
      </StrictMode>,
    );

    await waitFor(() => expect(statsSource()).toBeDefined());
    act(() => statsSource()?.emit({ admissionQueueCount: 600 }));
    await screen.findByText((_, el) => el?.textContent === "대기 중입니다 — 현재 순번 0");

    const resetCalls = fetchMock.mock.calls.filter(([u]) => u.toString().includes("/load-test/reset"));
    expect(resetCalls).toHaveLength(1);
  });
});
