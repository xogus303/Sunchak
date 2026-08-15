"use client";

import { useEffect, useState } from "react";
import { Modal } from "./modal";

export const QUEUE_NOTICE_SEEN_KEY = "sunchak:seenQueueNotice";

interface QueueNoticeModalProps {
  // 안내를 "확인해도 되는 상태"가 됐을 때 호출 — 이미 본 적 있으면 마운트 직후
  // 바로, 처음이면 "확인" 버튼을 눌러야 호출된다. 부모(events/[id]/page.tsx)가
  // 이 콜백을 받아서야 BookingForm의 대기열 자동 입장을 시작시킨다(2026-08-08,
  // 사용자 실측 발견 — 안내를 읽는 동안 가상유저 대기열이 허가 처리(2초당 20명)로
  // 다 빠져버려서, 안내와 실제 대기열 체감이 어긋나는 문제가 있었다).
  onAcknowledged: () => void;
}

// 이벤트 상세 페이지 진입 시 자동으로 한 번 뜨는 안내(2026-08-08, 사용자 요청) —
// "대기열이 왜 갑자기 생기지?"라는 혼란을 막기 위해, 방문자가 실제로 대기열에
// 던져지기 전에 그게 의도된 동작(ADR 0017 개정 참고)임을 먼저 알려준다.
// localStorage에 한 번 봤다는 표시를 남겨 재방문 시엔 다시 안 뜬다 — 매번 뜨면
// 반복 테스트하는 사용자에게 방해만 된다. 헤더의 "도움말" 전체 매뉴얼과는
// 완전히 별개(사용자 확인, 2026-08-08).
export function QueueNoticeModal({ onAcknowledged }: QueueNoticeModalProps) {
  const [open, setOpen] = useState(false);

  // react-hooks/set-state-in-effect 린트(booking-form.tsx의 자동 대기열 입장
  // effect와 같은 이유) — effect 본문에서 setState를 직접 호출하는 대신, 브라우저
  // API(localStorage) 조회 결과에 "반응"하는 콜백 안에서 호출하는 형태로 맞춘다.
  // 동작은 동일(마운트 시 1회 조회)하고, 조회 자체가 비동기일 필요는 없다.
  useEffect(() => {
    Promise.resolve().then(() => {
      if (window.localStorage.getItem(QUEUE_NOTICE_SEEN_KEY)) {
        onAcknowledged(); // 이미 본 적 있음 — 바로 대기열 입장을 시작해도 됨
      } else {
        setOpen(true);
      }
    });
  }, [onAcknowledged]);

  function close() {
    window.localStorage.setItem(QUEUE_NOTICE_SEEN_KEY, "1");
    setOpen(false);
    onAcknowledged();
  }

  return (
    <Modal open={open} onClose={close} title="대기열 안내">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        지금 보게 될 대기 순번은 실제로 동작하는 선착순 대기열입니다. 이 페이지에 들어오는
        순간 랜덤 규모의 가상 참가자들과 함께 자동으로 대기열에 참여되고, 순서가 되면
        예매가 가능해집니다 — 오류가 아니라 대량 트래픽 상황을 보여주기 위해 의도적으로
        만든 동작입니다.
      </p>
      <button
        onClick={close}
        className="self-start rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
      >
        확인
      </button>
    </Modal>
  );
}
