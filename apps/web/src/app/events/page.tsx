import Link from "next/link";
import { EventList } from "../event-list";

export default function EventsPage() {
  return (
    <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-16 dark:bg-black">
      <Link href="/" className="self-start text-sm text-zinc-500 hover:underline dark:text-zinc-400">
        ← 대시보드로
      </Link>
      <EventList />
    </div>
  );
}
