import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy, VerifyCallback } from 'passport-google-oauth20';
import { AuthService } from '../auth.service';

/**
 * passport-google-oauth20 전략 = "Google이 콜백으로 넘겨준 프로필을 받아
 * 우리 User로 어떻게 바꿀지"의 정의. JwtStrategy와 다른 점: JWT는 우리가
 * 서명한 토큰을 검증하는 것이지만, 이건 Google의 리다이렉트 흐름 자체를
 * passport가 대신 처리해준다(인가 URL 생성, code→토큰 교환, 프로필 조회).
 * validate()는 그 결과(프로필)를 받아 "우리 시스템의 사용자"로 매핑만 한다.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService,
    private readonly authService: AuthService,
  ) {
    // passport-oauth2가 clientID를 falsy로 판단하면 생성자에서 바로 throw한다
    // (JWT_SECRET처럼 하드 필수는 아니길 원해서) — 그래서 빈 문자열이 아니라
    // 의미 있는 플레이스홀더로 채운다. 미설정 상태로 실제 /auth/google을 두드리면
    // Google이 invalid_client로 거부할 뿐, 앱 부팅 자체는 막지 않는다.
    super({
      clientID: config.get<string>('GOOGLE_CLIENT_ID') || 'not-configured',
      clientSecret: config.get<string>('GOOGLE_CLIENT_SECRET') || 'not-configured',
      callbackURL:
        config.get<string>('GOOGLE_CALLBACK_URL') ||
        'http://localhost:3001/auth/google/callback',
      scope: ['email', 'profile'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ) {
    const user = await this.authService.findOrCreateGoogleUser(profile);
    done(null, user);
  }
}
