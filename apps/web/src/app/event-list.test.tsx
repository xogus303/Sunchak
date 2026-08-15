import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EventList } from "./event-list";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

describe("EventList (이벤트 목록/상세 통합, 2026-08-06 PRD 재검토)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    pushMock.mockReset();
    window.localStorage.clear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("이벤트를 전부 나열하고, 판매중/매진 상태를 라벨로 구분해 보여준다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 1, title: "선착순 데모 콘서트", description: "자유롭게 예매해보세요.", price: 10000, status: "ON_SALE" },
        { id: 2, title: "얼리버드 재즈 나이트", description: "이미 매진된 공연", price: 15000, status: "SOLD_OUT" },
      ],
    });

    render(<EventList />);

    await screen.findByText("선착순 데모 콘서트");
    expect(screen.getByText("판매중")).toBeInTheDocument();
    expect(screen.getByText("얼리버드 재즈 나이트")).toBeInTheDocument();
    expect(screen.getByText("매진")).toBeInTheDocument();
    expect(screen.getByText("10,000원")).toBeInTheDocument();
  });

  it("매진 이벤트는 클릭할 버튼 자체가 없다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 1, title: "선착순 데모 콘서트", description: null, price: 10000, status: "ON_SALE" },
        { id: 2, title: "얼리버드 재즈 나이트", description: null, price: 15000, status: "SOLD_OUT" },
      ],
    });

    render(<EventList />);
    await screen.findByText("선착순 데모 콘서트");

    expect(screen.getByText("선착순 데모 콘서트").closest("button")).not.toBeNull();
    expect(screen.getByText("얼리버드 재즈 나이트").closest("button")).toBeNull();
  });

  // 2026-08-08 재조정 — 판매중 카드를 누르면 곧바로 이동하지 않고 대기열 안내
  // 팝업이 먼저 뜨고, "확인"을 눌러야 상세 페이지로 이동한다. 안내를 읽는 동안
  // 실제 대기열이 이미 처리돼버리는 문제(사용자 실측)를 막기 위한 순서.
  it("판매중 카드를 누르면 대기열 안내가 먼저 뜨고, 확인해야 상세로 이동한다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 1, title: "선착순 데모 콘서트", description: null, price: 10000, status: "ON_SALE" },
      ],
    });

    render(<EventList />);
    await screen.findByText("선착순 데모 콘서트");

    fireEvent.click(screen.getByText("선착순 데모 콘서트"));

    await screen.findByText("대기열 안내");
    expect(pushMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "확인" }));

    expect(pushMock).toHaveBeenCalledWith("/events/1");
  });

  it("이미 안내를 본 상태면 카드를 누르는 즉시 상세로 이동한다", async () => {
    window.localStorage.setItem("sunchak:seenQueueNotice", "1");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 1, title: "선착순 데모 콘서트", description: null, price: 10000, status: "ON_SALE" },
      ],
    });

    render(<EventList />);
    await screen.findByText("선착순 데모 콘서트");

    fireEvent.click(screen.getByText("선착순 데모 콘서트"));

    await vi.waitUntil(() => pushMock.mock.calls.length > 0);
    expect(pushMock).toHaveBeenCalledWith("/events/1");
    expect(screen.queryByText("대기열 안내")).not.toBeInTheDocument();
  });

  // 회귀 테스트(2026-08-08 실사용 중 발견) — 세션이 무효화된(DB 초기화 등) 채로
  // /events를 불러오면 백엔드가 401/500 에러 바디({message,...})를 주는데,
  // 예전엔 그걸 그대로 이벤트 배열처럼 다뤄 events.map()에서 TypeError로 죽었다.
  it("이벤트 목록 조회가 실패하면(세션 무효 등) 에러 문구와 재로그인 링크를 보여준다", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ message: "이 계정을 더 이상 찾을 수 없습니다. 다시 로그인해 주세요." }),
    });

    render(<EventList />);

    await screen.findByText("이 계정을 더 이상 찾을 수 없습니다. 다시 로그인해 주세요.");
    expect(screen.getByRole("link", { name: "다시 로그인하기" })).toHaveAttribute("href", "/");
  });
});
