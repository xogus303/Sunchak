"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { HelpModal } from "./help-modal";

// 로그인된 앱 화면(이벤트 목록·상세)에만 뜨는 헤더(2026-08-08, 사용자 요청) —
// events/layout.tsx가 이 세그먼트에만 감싸서 게이트/로그인 화면(app/page.tsx)엔
// 안 나온다(아직 로그아웃할 대상이 없으니).
export function Header() {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);

  // JWT는 상태 없는(stateless) 토큰이라 서버가 무효화할 방법이 없다 — 로그아웃은
  // "브라우저가 더 이상 이 토큰을 안 보내게" httpOnly 쿠키를 서버가 대신 지워주는
  // 것으로 구현한다(백엔드 POST /auth/logout, auth.controller.ts 참고).
  async function handleLogout() {
    await apiFetch("/auth/logout", { method: "POST" });
    router.push("/");
  }

  return (
    <>
      <header className="flex w-full items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <span className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">Sunchak</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setHelpOpen(true)}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            도움말
          </button>
          <button
            onClick={handleLogout}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            로그아웃
          </button>
        </div>
      </header>
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
