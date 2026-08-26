import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { BookingForm } from "./booking-form";
import { FakeEventSource } from "../test/fake-event-source";

// 게이트/로그인 세션 만료 시 루트로 돌려보내는지 확인하려면 useRouter가 필요하다
// (page.test.tsx와 같은 패턴).
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function queueSource() {
  return FakeEventSource.instances.find((s) => s.url.includes("/queue/stream"));
}
function reservationSource() {
  return FakeEventSource.instances.find((s) => s.url.includes("/reservations/999/stream"));
}

// 순번 숫자를 <span>으로 감싸 텍스트가 두 노드로 나뉘어 있어(굵게 표시하려고),
// 문자열 매칭 대신 textContent를 직접 비교하는 함수 매처를 쓴다.
function findByRank(rank: number) {
  return screen.findByText(
    (_, element) => element?.textContent === `대기 중입니다 — 현재 순번 ${rank}`,
  );
}

// 이벤트를 선택하는(마운트되는) 순간 자동으로 랜덤 규모 가상 유저 투입 +
// 대기열 입장이 함께 일어난다(2026-08-07) — 항상 같이 오는 트래픽이라 기본
// mock에 깔아두고, 테스트별로 필요한 엔드포인트만 덧붙인다.
function baseFetchMock(extra: (url: string) => Promise<unknown> | null) {
  return async (url: string) => {
    const u = url.toString();
    if (u.includes("/demo/simulate")) return { ok: true, json: async () => ({ accepted: 20 }) };
    const result = await extra(u);
    if (result) return result;
    throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
  };
}

// 대기열 입장(자동) → 순번 → 입장 허가 → 예매하기까지는 세 테스트가 공유하는 경로라 헬퍼로 뽑는다.
async function waitUntilAdmitted() {
  await screen.findByText("내 예매 — 선착순 데모 콘서트");
  await findByRank(0);
  act(() => queueSource()?.emit({ rank: null, admitted: true }));
  await screen.findByText("지금 예매하세요 — 수량");
}

describe("BookingForm (대기열 → 예매 → 결제, ADR 0017/0018)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    pushMock.mockReset();
    FakeEventSource.instances = [];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("마운트되면 자동으로 대기열에 입장해 순번을 보여준다", async () => {
    fetchMock.mockImplementation(
      baseFetchMock((u) => (u.includes("/queue") ? Promise.resolve({ ok: true, json: async () => ({}) }) : null)),
    );
    render(<BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    await findByRank(0);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/events/1/queue"),
      expect.objectContaining({ method: "POST" }),
    );
    // 랜덤 규모(5~100명)의 가상 유저 투입도 함께 트리거됐는지(실제 경쟁 상황 재현).
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/demo/simulate"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  // ADR 0017 백로그(2026-08-15) — 순번에 예상 대기시간(ETA)을 붙이는 개선.
  // 서버가 etaSeconds를 안 준 스냅샷(다른 테스트들의 mock)은 그대로 문구가 안
  // 붙어야 하고(findByRank 헬퍼들의 정확 일치가 이미 이걸 보장), 값을 주면
  // 화면에 그 값이 반영되는지만 이 테스트에서 확인한다.
  it("서버가 준 etaSeconds를 예상 대기시간으로 표시한다", async () => {
    fetchMock.mockImplementation(
      baseFetchMock((u) => (u.includes("/queue") ? Promise.resolve({ ok: true, json: async () => ({}) }) : null)),
    );
    render(<BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    await findByRank(0);

    act(() => queueSource()?.emit({ rank: 5, admitted: false, etaSeconds: 12 }));
    await screen.findByText(
      (_, element) => element?.textContent === "대기 중입니다 — 현재 순번 5 (예상 대기 약 12초)",
    );

    act(() => queueSource()?.emit({ rank: 40, admitted: false, etaSeconds: 90 }));
    await screen.findByText(
      (_, element) => element?.textContent === "대기 중입니다 — 현재 순번 40 (예상 대기 약 2분)",
    );
  });

  // React StrictMode(Next.js App Router 개발 모드 기본값)는 마운트 시 effect를
  // 일부러 두 번 실행한다 — 가드 없이 두면 2번째 실행의 simulate 요청이 쿨다운에
  // 걸려 즉시 거부되고, 곧바로 본인 입장을 호출해 1번째 실행의 크라우드보다
  // 먼저 큐에 서버리는 버그가 있었다(2026-08-07 실사용 중 발견). ref 가드가
  // 이걸 막는지 StrictMode로 실제로 감싸서 검증한다.
  it("StrictMode로 마운트가 두 번 일어나도 투입·입장 요청은 한 번만 나간다", async () => {
    fetchMock.mockImplementation(
      baseFetchMock((u) => (u.includes("/queue") ? Promise.resolve({ ok: true, json: async () => ({}) }) : null)),
    );
    render(
      <StrictMode>
        <BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />
      </StrictMode>,
    );

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    await findByRank(0);

    const simulateCalls = fetchMock.mock.calls.filter(([url]) => url.toString().includes("/demo/simulate"));
    const queueCalls = fetchMock.mock.calls.filter(([url]) => url.toString().includes("/events/1/queue"));
    expect(simulateCalls).toHaveLength(1);
    expect(queueCalls).toHaveLength(1);
  });

  it("순번 표시 → 입장 허가 → 예매 → 결제 성공 시 확정 문구를 보여준다", async () => {
    fetchMock.mockImplementation(
      baseFetchMock((u) => {
        if (u.includes("/pay")) return Promise.resolve({ ok: true, json: async () => ({ status: "PENDING" }) });
        if (u.includes("/reservations")) {
          return Promise.resolve({ ok: true, json: async () => ({ id: 999, status: "HELD" }) });
        }
        if (u.includes("/queue")) return Promise.resolve({ ok: true, json: async () => ({ joined: true }) });
        return null;
      }),
    );
    render(<BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    await findByRank(0);
    act(() => queueSource()?.emit({ rank: 3, admitted: false }));
    await findByRank(3);

    act(() => queueSource()?.emit({ rank: null, admitted: true }));
    await screen.findByText("지금 예매하세요 — 수량");

    fireEvent.click(screen.getByRole("button", { name: "예매하기" }));
    // held 이후는 티켓 카드로 표시된다(2026-08-07) — 수량·상태 배지를 확인.
    await screen.findByText("🎫 1매");
    await screen.findByText("결제 대기");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/events/1/reservations?strategy=held"),
      expect.objectContaining({ method: "POST" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "결제하기" }));
    await screen.findByText("결제 처리 중");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/reservations/999/pay"),
      expect.objectContaining({ method: "POST" }),
    );

    act(() => reservationSource()?.emit({ reservationId: 999, status: "CONFIRMED" }));
    await screen.findByText("확정");
  });

  it("결제가 실패(CANCELLED)하면 좌석 반환 문구와 재시도 버튼을 보여준다", async () => {
    fetchMock.mockImplementation(
      baseFetchMock((u) => {
        if (u.includes("/pay")) return Promise.resolve({ ok: true, json: async () => ({ status: "PENDING" }) });
        if (u.includes("/reservations")) {
          return Promise.resolve({ ok: true, json: async () => ({ id: 999, status: "HELD" }) });
        }
        if (u.includes("/queue")) return Promise.resolve({ ok: true, json: async () => ({}) });
        return null;
      }),
    );
    render(<BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />);
    await waitUntilAdmitted();

    fireEvent.click(screen.getByRole("button", { name: "예매하기" }));
    await screen.findByText("결제 대기");

    fireEvent.click(screen.getByRole("button", { name: "결제하기" }));
    await screen.findByText("결제 처리 중");

    act(() => reservationSource()?.emit({ reservationId: 999, status: "CANCELLED" }));

    await screen.findByText("결제 실패");
    const retryButton = screen.getByRole("button", { name: "다시 예매하기" });
    expect(retryButton).toBeInTheDocument();

    // 회귀 테스트(2026-08-07 실사용 중 발견) — 이 버튼이 상태를 idle로만
    // 되돌리면, 대기열 자동 입장은 마운트 시 한 번만 도는 ref 가드 때문에
    // 다시 안 돌아 "대기열 입장 중..."에 영원히 멈춘다. 실제로 재입장까지
    // 되는지(순번을 다시 받는지) 확인한다.
    fetchMock.mockClear();
    fireEvent.click(retryButton);
    await findByRank(0);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/events/1/queue"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("입장 허가창을 놓치면(rank도 없고 허가도 없음) 만료 문구와 재입장 버튼을 보여준다", async () => {
    fetchMock.mockImplementation(
      baseFetchMock((u) => (u.includes("/queue") ? Promise.resolve({ ok: true, json: async () => ({}) }) : null)),
    );
    render(<BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    await findByRank(0);

    act(() => queueSource()?.emit({ rank: null, admitted: false }));

    await screen.findByText("입장 허가 시간이 지났습니다. 다시 대기열에 입장해 주세요.");
    expect(screen.getByRole("button", { name: "다시 대기열 입장" })).toBeInTheDocument();
  });

  it("재고 부족(409) 시 에러 메시지와 재시도 버튼을 보여준다", async () => {
    fetchMock.mockImplementation(
      baseFetchMock((u) => {
        if (u.includes("/reservations")) {
          return Promise.resolve({ ok: false, json: async () => ({ message: "재고가 부족합니다." }) });
        }
        if (u.includes("/queue")) return Promise.resolve({ ok: true, json: async () => ({}) });
        return null;
      }),
    );
    render(<BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    await findByRank(0);

    act(() => queueSource()?.emit({ rank: null, admitted: true }));
    await screen.findByText("지금 예매하세요 — 수량");

    fireEvent.click(screen.getByRole("button", { name: "예매하기" }));

    await screen.findByText("재고가 부족합니다.");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  it("로그인 안 된 상태로 마운트되면(대기열 입장 401) 에러 메시지를 보여준다", async () => {
    // /events/[id]가 별도 페이지로 분리되며(2026-08-06) 로그인 전에도 이 화면에
    // 올 수 있게 된 것에 대한 회귀 테스트. 이제 대기열 입장이 자동이라 마운트만
    // 해도 401을 재현할 수 있다.
    fetchMock.mockImplementation(
      baseFetchMock((u) =>
        u.includes("/queue")
          ? Promise.resolve({ ok: false, json: async () => ({ message: "Unauthorized" }) })
          : null,
      ),
    );
    render(<BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />);

    await screen.findByText("내 예매 — 선착순 데모 콘서트");
    await screen.findByText("Unauthorized");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  // 2026-08-27 실사용 중 발견 — 게이트 토큰(로그인과 별개의 막)이 장시간
  // 테스트로 만료되면, "다시 시도"가 같은 예매 액션을 그대로 재실행해 매번
  // 똑같은 만료 에러만 반복됐다("다시 시도할 수 없다"는 리포트). 이 경우는
  // 루트로 돌려보내야 한다.
  it("게이트 토큰이 만료되면 '다시 시도' 대신 루트로 돌려보내는 버튼을 보여준다", async () => {
    fetchMock.mockImplementation(
      baseFetchMock((u) =>
        u.includes("/queue")
          ? Promise.resolve({ ok: false, json: async () => ({ message: "유효하지 않거나 만료된 데모 토큰입니다." }) })
          : null,
      ),
    );
    render(<BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />);

    await screen.findByText("유효하지 않거나 만료된 데모 토큰입니다.");
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "처음부터 다시 시작하기" });

    fireEvent.click(retryButton);
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("로그인 세션의 유저 계정을 더 이상 찾을 수 없으면(JWT는 유효하나 DB에 없음) 루트로 돌려보내는 버튼을 보여준다", async () => {
    fetchMock.mockImplementation(
      baseFetchMock((u) =>
        u.includes("/queue")
          ? Promise.resolve({ ok: false, json: async () => ({ message: "이 계정을 더 이상 찾을 수 없습니다. 다시 로그인해 주세요." }) })
          : null,
      ),
    );
    render(<BookingForm
      eventId={1}
      eventTitle="선착순 데모 콘서트"
      joinQueueUrl="/events/1/queue"
      queueStreamUrl="/events/1/queue/stream"
    />);

    await screen.findByText("이 계정을 더 이상 찾을 수 없습니다. 다시 로그인해 주세요.");
    const retryButton = screen.getByRole("button", { name: "처음부터 다시 시작하기" });

    fireEvent.click(retryButton);
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  // 대용량 트래픽 테스트(/load-test, 2026-08-26)도 캐주얼과 같은 1인칭 대기열
  // 체험을 준다 — 단 eventId를 URL이 아니라 join 응답으로 받고, 크라우드는
  // "가상 유저 투입" 버튼으로 유저가 직접 통제하므로 자동 투입은 꺼져 있다.
  describe("대용량 모드(eventId 없이, autoInjectCrowd=false)", () => {
    it("마운트 시 크라우드 자동 투입 없이 곧바로 본인만 대기열에 입장한다", async () => {
      fetchMock.mockImplementation(async (u: string) => {
        if (u.toString().includes("/demo/simulate")) {
          throw new Error("대용량 모드는 크라우드를 자동 투입하면 안 된다");
        }
        if (u.toString().includes("/load-test/queue")) {
          return { ok: true, json: async () => ({ eventId: 42 }) };
        }
        throw new Error(`이 테스트에서 예상하지 못한 fetch: ${u}`);
      });
      render(
        <BookingForm
          eventTitle="대용량 트래픽 테스트"
          joinQueueUrl="/load-test/queue"
          queueStreamUrl="/load-test/queue/stream"
          autoInjectCrowd={false}
        />,
      );

      await screen.findByText("내 예매 — 대용량 트래픽 테스트");
      await findByRank(0);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/load-test/queue"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("join 응답으로 받은 eventId를 예매 생성에 그대로 쓴다", async () => {
      // 순번/허가 스트림은 EventSource가 처리해 fetch를 안 타므로 여기 mock할 필요 없다.
      fetchMock.mockImplementation(async (u: string) => {
        const url = u.toString();
        if (url.includes("/load-test/queue")) {
          return { ok: true, json: async () => ({ eventId: 42 }) };
        }
        if (url.includes("/reservations")) {
          return { ok: true, json: async () => ({ id: 999, status: "HELD" }) };
        }
        throw new Error(`이 테스트에서 예상하지 못한 fetch: ${url}`);
      });
      render(
        <BookingForm
          eventTitle="대용량 트래픽 테스트"
          joinQueueUrl="/load-test/queue"
          queueStreamUrl="/load-test/queue/stream"
          autoInjectCrowd={false}
        />,
      );

      await screen.findByText("내 예매 — 대용량 트래픽 테스트");
      await findByRank(0);
      const source = FakeEventSource.instances.find((s) => s.url.includes("/load-test/queue/stream"));
      act(() => source?.emit({ rank: null, admitted: true }));
      await screen.findByText("지금 예매하세요 — 수량");

      fireEvent.click(screen.getByRole("button", { name: "예매하기" }));

      await screen.findByText("🎫 1매");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/events/42/reservations?strategy=held"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
