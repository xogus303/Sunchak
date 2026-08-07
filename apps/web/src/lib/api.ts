const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// 백엔드가 HttpOnly 쿠키(access_token/demo_token)로 인증하므로, 모든 요청에
// credentials:'include'가 빠지면 안 된다 — 이걸 매번 손으로 쓰는 대신 여기서 강제한다.
export async function apiFetch(path: string, init?: RequestInit) {
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

export function apiUrl(path: string) {
  return `${API_URL}${path}`;
}
