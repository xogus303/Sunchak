import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { DEMO_TOKEN_COOKIE } from '../../common/auth-cookie';
import { DemoGatePayload } from '../demo.service';

/**
 * 첫 전역 가드(APP_GUARD) — API 전체의 진입을 차단한다(ADR 0016 축 A).
 * 로그인(JwtAuthGuard, 라우트별)과 완전히 별개의 막이다 — 이건 "누구든 이
 * 서비스에 들어올 자격이 있나"만 본다. 헤더도 Authorization과 겹치지 않게
 * X-Demo-Token을 따로 쓴다.
 */
@Injectable()
export class DemoGateGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // 비번이 설정 안 돼 있으면(로컬 개발 기본값) 게이트를 비활성화한다 — 배포
    // 환경에서만 DEMO_GATE_PASSWORD를 설정해 게이트를 켠다. 새 on/off 플래그를
    // 추가하는 대신 이미 있는 값의 유무 자체를 신호로 쓴다.
    if (!this.config.get<string>('DEMO_GATE_PASSWORD')) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    // 쿠키(브라우저 자동 전송) 우선, 없으면 헤더(curl 등 수동 검증용) — JWT와 같은 원칙.
    const token: unknown =
      request.cookies?.[DEMO_TOKEN_COOKIE] ?? request.headers['x-demo-token'];
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('데모 게이트를 먼저 통과하세요.');
    }

    try {
      const payload = this.jwt.verify<DemoGatePayload>(token);
      if (payload.type !== 'demo') {
        throw new Error('unexpected token type');
      }
    } catch {
      throw new UnauthorizedException('유효하지 않거나 만료된 데모 토큰입니다.');
    }

    return true;
  }
}
