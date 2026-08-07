import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeEventSource } from "../../../test/fake-event-source";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "1" }),
}));

import EventDetailPage from "./page";

// ON_SALE 분기에서 함께 렌더되는 DemoDashboard가 useMutation(TanStack Query)을
// 쓰므로, 실제 앱(RootLayout의 Providers)과 마찬가지로 QueryClientProvider가 필요하다.
function renderPage() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <EventDetailPage />
    </QueryClientProvider>,
  );
}

// 판매중(ON_SALE)인 이벤트만 예매 화면(BookingForm)까지 들어갈 수 있다는 제약을
// 검증한다(2026-08-06, 이벤트 목록이 별도 페이지로 분리되며 추가).
describe("EventDetailPage (판매중인 이벤트만 진입 가능)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    FakeEventSource.instances = [];
    vi.stubGlobal("fetch", fetchMock);
    // DemoDashboard(판매현황+가상유저투입)가 ON_SALE 페이지에 함께 렌더되며
    // stats SSE를 열므로(2026-08-06, BookingForm과 한 페이지로 합침) jsdom에 없는
    // EventSource를 흉내내야 한다.
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("판매중(ON_SALE) 이벤트면 예매 화면(BookingForm)을 보여준다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 1, title: "선착순 데모 콘서트", description: null, price: 10000, status: "ON_SALE" }),
    });

    renderPage();

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    // 예매(BookingForm)뿐 아니라 판매현황·가상유저투입(DemoDashboard)도
    // 같은 화면에 함께 나와야 방문자가 자기 예매 결과를 바로 지켜볼 수 있다.
    expect(screen.getByText("실시간 판매 현황")).toBeInTheDocument();
  });

  it("판매중이 아닌 이벤트면 예매 화면 대신 안내 문구를 보여준다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 2, title: "얼리버드 재즈 나이트", description: null, price: 15000, status: "SOLD_OUT" }),
    });

    renderPage();

    await screen.findByText("얼리버드 재즈 나이트은(는) 지금 판매중이 아닙니다.");
    expect(screen.queryByText(/내 예매/)).not.toBeInTheDocument();
  });

  it("존재하지 않는 이벤트면 찾을 수 없다는 문구를 보여준다", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ message: "이벤트를 찾을 수 없습니다." }),
    });

    renderPage();

    await screen.findByText("이벤트를 찾을 수 없습니다.");
  });
});
