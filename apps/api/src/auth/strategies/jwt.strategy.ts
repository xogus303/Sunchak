import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

/** 로그인 때 우리가 넣은 JWT payload의 모양. */
export interface JwtPayload {
  sub: number; // userId (표준 "subject" 클레임)
  email: string;
  role: string;
}

/**
 * passport-jwt 전략 = "요청에서 JWT를 어떻게 꺼내고 어떻게 검증할지"의 정의.
 * - jwtFromRequest: Authorization: Bearer <token> 헤더에서 토큰 추출
 * - secretOrKey: 이 키로 서명을 검증 (위조/변조 차단)
 * - 서명·만료가 유효하면 validate()가 호출되고, 반환값이 request.user에 담긴다.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET이 설정되지 않았습니다.');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(payload: JwtPayload) {
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
