import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Header } from "./header";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// 로그인된 앱 화면(이벤트 목록·상세)에만 뜨는 헤더(2026-08-08) — 도움말·로그아웃
// 버튼 노출과 각각의 동작을 확인한다.
describe("Header", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    pushMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("도움말 버튼을 누르면 전체 매뉴얼 팝업이 뜬다", () => {
    render(<Header />);

    expect(screen.queryByText("목적")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "도움말" }));
    expect(screen.getByText("목적")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByText("목적")).not.toBeInTheDocument();
  });

  it("로그아웃 버튼을 누르면 POST /auth/logout 후 게이트 화면으로 이동한다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ loggedOut: true }) });
    render(<Header />);

    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/auth/logout"),
        expect.objectContaining({ method: "POST" }),
      );
      expect(pushMock).toHaveBeenCalledWith("/");
    });
  });
});
