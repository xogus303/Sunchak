"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, apiUrl } from "@/lib/api";
import { GateForm } from "./gate-form";

// "dashboard" = 게이트+로그인 모두 통과. 예전엔 이 상태에서 곧바로 통계
// 대시보드를 그렸지만, 이벤트 목록이 별도 페이지로 분리되며(2026-08-06) 이제는
// /events로 넘어간다 — 목록 렌더링 코드를 두 곳에 두지 않기 위해 리다이렉트로 처리.
type Status = "checking" | "gate" | "login" | "dashboard" | "error";

// 전용 "게이트/로그인 상태" 엔드포인트가 없어서, 이미 있는 GET /auth/me를
// 재활용한다. 이 라우트는 전역 게이트 가드 → JwtAuthGuard 순으로 걸리므로,
// 401 응답의 message 문자열로 "어느 막에서 막혔는지"를 구분한다:
// - 게이트 실패: DemoGateGuard가 한글 메시지("데모 게이트를 먼저 통과하세요" 등)
// - 로그인 실패: passport-jwt 기본 메시지("Unauthorized")
// ⚠️ 백엔드가 이 문자열을 바꾸면 이 판별도 같이 깨진다(약한 결합).
//
// fetch 자체가 거부(reject)될 수 있어(API 서버 다운·네트워크 단절 등) try/catch로
// 감싼다 — 없으면 이 promise가 조용히 실패하면서 setStatus가 영영 안 불려
// "확인 중..." 화면에 멈춘 채로 아무 피드백도 없이 굳어버린다(2026-08-26 발견).
async function checkStatus(): Promise<Status> {
  try {
    const res = await apiFetch("/auth/me");
    if (res.ok) return "dashboard";
    const body = await res.json().catch(() => null);
    const message: string = body?.message ?? "";
    if (message.includes("게이트") || message.includes("토큰")) return "gate";
    return "login";
  } catch {
    return "error";
  }
}

export default function Home() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");

  // "checking"으로 먼저 되돌려 재시도 중임을 보여준다 — 안 그러면(특히 서버가
  // 여전히 안 떠 있어 결과가 또 "error"인 경우) 화면이 안 바뀌어 버튼이 반응
  // 없는 것처럼 보인다(2026-08-26 발견).
  const refreshStatus = useCallback(() => {
    setStatus("checking");
    checkStatus().then(setStatus);
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status === "dashboard") router.replace("/events");
  }, [status, router]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 bg-zinc-50 px-6 py-16 dark:bg-black">
      <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Sunchak 데모</h1>

      {status === "checking" && <p className="text-sm text-zinc-500">확인 중...</p>}

      {status === "gate" && <GateForm onSuccess={refreshStatus} />}

      {status === "login" && (
        <a
          href={apiUrl("/auth/google")}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Google로 로그인
        </a>
      )}

      {status === "dashboard" && <p className="text-sm text-zinc-500">이동 중...</p>}

      {status === "error" && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-red-600 dark:text-red-400">서버에 연결할 수 없습니다.</p>
          <button
            onClick={refreshStatus}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            다시 시도
          </button>
        </div>
      )}
    </div>
  );
}
