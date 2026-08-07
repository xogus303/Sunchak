"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, apiUrl } from "@/lib/api";
import { GateForm } from "./gate-form";

// "dashboard" = 게이트+로그인 모두 통과. 예전엔 이 상태에서 곧바로 통계
// 대시보드를 그렸지만, 이벤트 목록이 별도 페이지로 분리되며(2026-08-06) 이제는
// /events로 넘어간다 — 목록 렌더링 코드를 두 곳에 두지 않기 위해 리다이렉트로 처리.
type Status = "checking" | "gate" | "login" | "dashboard";

// 전용 "게이트/로그인 상태" 엔드포인트가 없어서, 이미 있는 GET /auth/me를
// 재활용한다. 이 라우트는 전역 게이트 가드 → JwtAuthGuard 순으로 걸리므로,
// 401 응답의 message 문자열로 "어느 막에서 막혔는지"를 구분한다:
// - 게이트 실패: DemoGateGuard가 한글 메시지("데모 게이트를 먼저 통과하세요" 등)
// - 로그인 실패: passport-jwt 기본 메시지("Unauthorized")
// ⚠️ 백엔드가 이 문자열을 바꾸면 이 판별도 같이 깨진다(약한 결합).
async function checkStatus(): Promise<Status> {
  const res = await apiFetch("/auth/me");
  if (res.ok) return "dashboard";
  const body = await res.json().catch(() => null);
  const message: string = body?.message ?? "";
  if (message.includes("게이트") || message.includes("토큰")) return "gate";
  return "login";
}

export default function Home() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");

  const refreshStatus = useCallback(() => {
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
    </div>
  );
}
