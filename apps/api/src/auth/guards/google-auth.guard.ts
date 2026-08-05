import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * AuthGuard('google') → 위 GoogleStrategy를 돌린다. JwtAuthGuard와 달리
 * "토큰 검증"이 아니라 "리다이렉트 흐름 전체"를 이 가드가 트리거한다 —
 * /auth/google에 붙이면 자동으로 Google 로그인 페이지로 리다이렉트되고,
 * /auth/google/callback에 붙이면 돌아온 code를 받아 GoogleStrategy.validate까지 실행한다.
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}
