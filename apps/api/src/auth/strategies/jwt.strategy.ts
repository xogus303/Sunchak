import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { Request } from "express";
import { ACCESS_TOKEN_COOKIE } from "../../common/auth-cookie";
import { PrismaService } from "../../prisma/prisma.service";

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
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
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

  // JWT는 서명·만료만 검증하면 "위조되지 않았다"는 것만 보장할 뿐, 그 안의
  // userId가 지금도 실제로 존재하는지는 보장하지 않는다(상태 없는 토큰의
  // 근본 한계, ADR 0013 참고). 이 프로젝트는 개발 중 `jest`가 DB를 통째로
  // 비우는 일이 잦아서, 브라우저에 남은 예전 쿠키가 "서명은 유효하지만
  // 그 유저는 이제 없음" 상태가 되기 쉽다 — 그대로 통과시키면 이후
  // demoOwnerId 같은 FK를 참조하는 곳에서 원인을 알기 힘든 500으로 죽는다
  // (2026-08-08 실사용 중 발견). 그래서 매 요청마다 DB로 한 번 더 확인한다 —
  // 무상태 인증의 성능 이점을 살짝 내주고, "지금 이 유저가 실재하는가"를
  // 정확히 보장하는 쪽을 택했다. validate()가 null/undefined를 반환하면
  // passport가 자동으로 401을 던진다(명시적으로 UnauthorizedException을
  // 던져도 결과는 같지만, 이유를 로그에 남기기 위해 직접 던진다).
  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException("이 계정을 더 이상 찾을 수 없습니다. 다시 로그인해 주세요.");
    }
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
