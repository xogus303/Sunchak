import { Header } from "../header";

// /events, /events/[id] 전용 레이어(2026-08-08) — 이 세그먼트는 게이트+로그인을
// 모두 통과한 뒤에만 도달하므로(events/[id]/page.tsx 기존 주석 참고) 헤더의
// "로그아웃" 버튼이 항상 의미 있다. 루트 게이트/로그인 화면(app/page.tsx)엔
// 아직 로그아웃할 대상이 없어 헤더를 안 보여준다.
export default function EventsLayout({ children }: LayoutProps<"/events">) {
  return (
    <div className="flex flex-1 flex-col">
      <Header />
      {children}
    </div>
  );
}
