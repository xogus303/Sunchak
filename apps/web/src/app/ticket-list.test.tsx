import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TicketList } from "./ticket-list";
import type { TicketSummary } from "./use-demo-stats";

// 좌측 "내 예매" 패널로 옮겨온 티켓 목록(2026-08-07) — 내 티켓과 다른 참가자
// 티켓을 섞지 않고 별도 섹션(내 티켓이 위)으로 나누는 게 핵심 요구사항.
describe("TicketList", () => {
  it("내 티켓과 다른 참가자 티켓을 별도 섹션으로 나눠 보여준다(내 티켓이 위)", () => {
    const tickets: TicketSummary[] = [
      { id: 1, quantity: 2, status: "HELD", paymentStatus: null, isMine: true },
      { id: 2, quantity: 1, status: "CONFIRMED", paymentStatus: "PAID", isMine: false },
      { id: 3, quantity: 3, status: "CANCELLED", paymentStatus: "FAILED", isMine: false },
    ];
    render(<TicketList tickets={tickets} />);

    const mineSection = screen.getByText("내 티켓 (1건)").closest("div")!;
    const othersSection = screen.getByText("다른 참가자 티켓 (2건)").closest("div")!;

    expect(within(mineSection).getByText("🎫 2매")).toBeInTheDocument();
    expect(within(othersSection).getByText("🎫 1매")).toBeInTheDocument();
    expect(within(othersSection).getByText("🎫 3매")).toBeInTheDocument();

    // DOM 순서상으로도 "내 티켓" 섹션이 먼저 나와야 한다(상단 고정 요구사항).
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["내 티켓 (1건)", "다른 참가자 티켓 (2건)"]);
  });

  it("티켓이 없으면 각 섹션에 빈 상태 문구를 보여준다", () => {
    render(<TicketList tickets={[]} />);

    expect(screen.getByText("내 티켓 (0건)")).toBeInTheDocument();
    expect(screen.getByText("아직 예매한 티켓이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("다른 참가자 티켓 (0건)")).toBeInTheDocument();
    expect(screen.getByText("아직 없습니다.")).toBeInTheDocument();
  });
});
