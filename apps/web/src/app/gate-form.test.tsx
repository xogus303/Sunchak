import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GateForm } from "./gate-form";

describe("GateForm", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("비밀번호를 입력하지 않으면 입장하기 버튼이 비활성화된다", () => {
    render(<GateForm onSuccess={vi.fn()} />);
    expect(screen.getByRole("button", { name: "입장하기" })).toBeDisabled();
  });

  it("게이트 통과에 성공하면 onSuccess를 호출한다", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ demoToken: "token" }),
    });
    const onSuccess = vi.fn();
    render(<GateForm onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText("데모 공유 비밀번호"), {
      target: { value: "sunchak-demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "입장하기" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/demo/gate"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("게이트 통과에 실패하면 서버 에러 메시지를 보여주고 onSuccess는 호출하지 않는다", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: "유효하지 않거나 만료된 데모 토큰입니다." }),
    });
    const onSuccess = vi.fn();
    render(<GateForm onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText("데모 공유 비밀번호"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "입장하기" }));

    await screen.findByText("유효하지 않거나 만료된 데모 토큰입니다.");
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
