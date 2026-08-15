import Link from "next/link";
import { EventList } from "../event-list";
import { AutoHelpPopup } from "../auto-help-popup";

// 로그인 후 항상 도착하는 첫 화면이라(app/page.tsx가 로그인 완료 시 여기로
// 리다이렉트), "로그인 후 최초 진입 시 도움말 자동 표시"를 여기 건다(2026-08-08).
export default function EventsPage() {
  return (
    <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-16 dark:bg-black">
      <AutoHelpPopup />
      <Link href="/" className="self-start text-sm text-zinc-500 hover:underline dark:text-zinc-400">
        ← 대시보드로
      </Link>
      <EventList />
    </div>
  );
}
