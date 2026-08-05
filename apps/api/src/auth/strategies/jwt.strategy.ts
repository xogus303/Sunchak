import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { Request } from "express";
import { ACCESS_TOKEN_COOKIE } from "../../common/auth-cookie";

/** 로그인 때 우리가 넣은 JWT payload의 모양. */
export interface JwtPayload {
  sub: number; // userId (표준 "subject" 클레임)
  email: string;
  role: string;
}

/**
 * passport-jwt 전략 = "요청에서 JWT를 어떻게 꺼내고 어떻게 검증할지"의 정의.
 * - jwtFromRequest: 쿠키 또는 Authorization: Bearer 헤더에서 토큰 추출(브라우저는
 *   쿠키로 자동 전송, curl 등 수동 검증은 헤더로 — 둘 다 표준적인 소스라 함께 지원).
 *   fromExtractors는 배열을 순서대로 시도해 처음 찾은 값을 쓴다.
 * - secretOrKey: 이 키로 서명을 검증 (위조/변조 차단)
 * - 서명·만료가 유효하면 validate()가 호출되고, 반환값이 request.user에 담긴다.
 */
@Injectable() // 이 클래스는 DI(주입) 대상이라는 표시
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const secret = config.get<string>("JWT_SECRET");
    if (!secret) {
      throw new Error("JWT_SECRET이 설정되지 않았습니다.");
    }
    // 부모(passport Strategy) 생성자 호출.
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.[ACCESS_TOKEN_COOKIE] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false, // 만료는 거부
      secretOrKey: secret, // 이 키로 서명 검증
    });
  }

  validate(payload: JwtPayload) {
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
