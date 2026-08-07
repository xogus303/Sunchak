import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Home from "./page";
import { FakeEventSource } from "../test/fake-event-source";

// page.tsx가 게이트+로그인 통과 후 /events로 리다이렉트한다(2026-08-06,
// 이벤트 목록이 별도 페이지로 분리됨) — vitest는 vi.mock을 파일 상단으로
// 끌어올려주므로(hoisting) 아래 정적 import보다 먼저 적용된다.
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

// page.tsx는 GET /auth/me 응답의 message 문자열로 게이트/로그인 상태를 구분한다
// (전용 상태 엔드포인트가 없어서 재활용하는 설계 — STATUS.md 2026-08-06 참고).
function renderHome() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <Home />
    </QueryClientProvider>,
  );
}

describe("Home (게이트/로그인/대시보드 분기)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    replaceMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("게이트 미통과(한글 에러) 시 게이트 폼을 보여준다", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: "데모 게이트를 먼저 통과하세요." }),
    });
    renderHome();

    await screen.findByLabelText("데모 공유 비밀번호");
  });

  it("게이트는 통과했지만 로그인 안 됨(Unauthorized) 시 Google 로그인 버튼을 보여준다", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: "Unauthorized" }),
    });
    renderHome();

    const link = await screen.findByRole("link", { name: "Google로 로그인" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/auth/google"));
  });

  it("게이트+로그인 모두 통과 시 /events로 이동한다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/auth/me")) {
        return { ok: true, json: async () => ({ id: 1, email: "a@b.com" }) };
      }
      throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
    });
    renderHome();

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/events"));
  });
});
