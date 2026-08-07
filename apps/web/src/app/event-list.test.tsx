import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventList } from "./event-list";

describe("EventList (이벤트 목록/상세 통합, 2026-08-06 PRD 재검토)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
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

  it("판매중인 이벤트만 상세/예매 페이지로 들어갈 수 있고, 매진 이벤트는 클릭할 수 없다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 1, title: "선착순 데모 콘서트", description: null, price: 10000, status: "ON_SALE" },
        { id: 2, title: "얼리버드 재즈 나이트", description: null, price: 15000, status: "SOLD_OUT" },
      ],
    });

    render(<EventList />);
    await screen.findByText("선착순 데모 콘서트");

    expect(screen.getByText("선착순 데모 콘서트").closest("a")).toHaveAttribute(
      "href",
      "/events/1",
    );
    expect(screen.getByText("얼리버드 재즈 나이트").closest("a")).toBeNull();
  });
});
