import { Header } from "../header";

// events/layout.tsx와 같은 이유(게이트+로그인 이후에만 도달하는 세그먼트라
// 헤더의 로그아웃 버튼이 항상 의미 있다).
export default function LoadTestLayout({ children }: LayoutProps<"/load-test">) {
  return (
    <div className="flex flex-1 flex-col">
      <Header />
      {children}
    </div>
  );
}
