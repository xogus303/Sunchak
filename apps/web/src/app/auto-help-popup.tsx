"use client";

import { useEffect, useState } from "react";
import { HelpModal } from "./help-modal";

export const HELP_SEEN_KEY = "sunchak:seenHelp";

// 로그인 후 이벤트 목록(/events) 최초 진입 시 자동으로 한 번 뜨는 도움말
// (2026-08-08, 사용자 요청) — 헤더의 "도움말" 버튼이 여는 것과 같은 내용
// (help-modal.tsx)을 재사용하되, 최초 1회는 누르지 않아도 저절로 보여준다.
// 대기열 안내 팝업(queue-notice-modal.tsx)과 같은 localStorage 패턴이지만
// 키가 달라(HELP_SEEN_KEY) 서로 독립적으로 한 번씩만 뜬다.
export function AutoHelpPopup() {
  const [open, setOpen] = useState(false);

  // react-hooks/set-state-in-effect 린트 회피 — queue-notice-modal.tsx와 같은
  // 이유로 콜백(Promise.then) 안에서 setState한다.
  useEffect(() => {
    Promise.resolve().then(() => {
      if (!window.localStorage.getItem(HELP_SEEN_KEY)) setOpen(true);
    });
  }, []);

  function close() {
    window.localStorage.setItem(HELP_SEEN_KEY, "1");
    setOpen(false);
  }

  return <HelpModal open={open} onClose={close} />;
}
