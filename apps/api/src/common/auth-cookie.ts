import { CookieOptions } from 'express';

// 쿠키 이름 — 토큰을 심는 쪽(컨트롤러)과 읽는 쪽(가드·전략)이 이 상수를 공유해
// 문자열 오타로 인한 불일치를 막는다(reservations.constants.ts의 CONFIRM_QUEUE와 같은 이유).
export const ACCESS_TOKEN_COOKIE = 'access_token'; // 로그인 JWT
export const DEMO_TOKEN_COOKIE = 'demo_token'; // 데모 게이트 토큰

// 로그인 JWT·데모 게이트 토큰이 공유하는 쿠키 정책.
// - httpOnly: JS(document.cookie)가 못 읽게 — XSS로 토큰이 새는 걸 막는다.
// - maxAge/expires를 안 둔다: 브라우저 세션 쿠키로 둬도, JWT 자체 서명에 담긴
//   만료는 서버가 검증 시 어차피 거부한다(ignoreExpiration:false) — 쿠키
//   수명을 JWT_EXPIRES_IN 문자열("1h")과 굳이 맞추려고 파싱 의존성을 늘릴
//   필요가 없다.
// - secure/sameSite는 배포 환경(다른 도메인)에서 SameSite=None+Secure가
//   강제되므로 NODE_ENV로 분기해둔다(로컬은 http라 Secure면 아예 전송 안 됨).
export function authCookieOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  };
}
