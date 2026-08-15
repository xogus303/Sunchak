import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutoHelpPopup, HELP_SEEN_KEY } from "./auto-help-popup";

// 로그인 후 /events 최초 진입 시 자동으로 한 번 뜨는 도움말(2026-08-08) —
// queue-notice-modal.test.tsx와 같은 검증 패턴, 다른 localStorage 키.
describe("AutoHelpPopup", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("처음 마운트되면 자동으로 도움말이 뜬다", async () => {
    render(<AutoHelpPopup />);

    await screen.findByText("목적");
  });

  it("닫으면 localStorage에 봤다는 표시가 남는다", async () => {
    render(<AutoHelpPopup />);

    fireEvent.click(await screen.findByRole("button", { name: "닫기" }));

    expect(screen.queryByText("목적")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(HELP_SEEN_KEY)).toBe("1");
  });

  it("이미 본 상태면 다시 마운트해도 안 뜬다", () => {
    window.localStorage.setItem(HELP_SEEN_KEY, "1");

    render(<AutoHelpPopup />);

    expect(screen.queryByText("목적")).not.toBeInTheDocument();
  });
});
