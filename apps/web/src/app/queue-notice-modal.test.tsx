import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueueNoticeModal, QUEUE_NOTICE_SEEN_KEY } from "./queue-notice-modal";

// 이벤트 상세 진입 시 자동으로 한 번만 뜨는 안내(2026-08-08) — localStorage로
// "봤음" 여부를 기억하는 게 핵심 요구사항이라, 매 테스트마다 초기화해서 확인한다.
// onAcknowledged(2026-08-08 추가) — 부모(events/[id]/page.tsx)가 이걸로 대기열
// 자동 입장 시작 시점을 늦춘다(안내를 읽는 동안 크라우드가 이미 빠지는 문제 방지).
describe("QueueNoticeModal", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("처음 마운트되면 자동으로 안내 팝업이 뜨고, 확인 전엔 onAcknowledged를 안 부른다", async () => {
    const onAcknowledged = vi.fn();
    render(<QueueNoticeModal onAcknowledged={onAcknowledged} />);

    await screen.findByText("대기열 안내");
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it("확인을 누르면 닫히고, localStorage 기록 + onAcknowledged 호출까지 된다", async () => {
    const onAcknowledged = vi.fn();
    render(<QueueNoticeModal onAcknowledged={onAcknowledged} />);

    fireEvent.click(await screen.findByRole("button", { name: "확인" }));

    expect(screen.queryByText("대기열 안내")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(QUEUE_NOTICE_SEEN_KEY)).toBe("1");
    expect(onAcknowledged).toHaveBeenCalledTimes(1);
  });

  it("이미 본 상태면 다시 마운트해도 안 뜨고, onAcknowledged가 바로 호출된다", async () => {
    window.localStorage.setItem(QUEUE_NOTICE_SEEN_KEY, "1");
    const onAcknowledged = vi.fn();

    render(<QueueNoticeModal onAcknowledged={onAcknowledged} />);

    await vi.waitUntil(() => onAcknowledged.mock.calls.length > 0);
    expect(screen.queryByText("대기열 안내")).not.toBeInTheDocument();
  });
});
