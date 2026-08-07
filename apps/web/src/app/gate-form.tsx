"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

// 데모 게이트(ADR 0016 축 A) — 로그인과 별개의 "공유 비번" 막. 통과하면 서버가
// demo_token 쿠키를 심어주므로, 이 컴포넌트는 성공 여부만 부모에게 알리면 된다.
export function GateForm({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await apiFetch("/demo/gate", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setPending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.message ?? "게이트 통과에 실패했습니다.");
      return;
    }
    onSuccess();
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="gate-password" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          데모 공유 비밀번호
        </label>
        <input
          id="gate-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          autoFocus
        />
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={pending || !password}
        className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {pending ? "확인 중..." : "입장하기"}
      </button>
    </form>
  );
}
