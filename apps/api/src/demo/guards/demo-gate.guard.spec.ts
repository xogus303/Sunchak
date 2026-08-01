import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DemoGateGuard } from './demo-gate.guard';
import { Public } from '../decorators/public.decorator';

// 실제 HTTP/DB 없이 canActivate()의 판단 로직만 검증하는 순수 단위 테스트.
// ExecutionContext는 가드가 실제로 쓰는 세 메서드(getHandler/getClass/
// switchToHttp().getRequest())만 흉내낸다.
class DummyController {
  @Public()
  publicRoute() {}
  protectedRoute() {}
}

function makeContext(
  handlerName: 'publicRoute' | 'protectedRoute',
  headers: Record<string, string> = {},
): ExecutionContext {
  return {
    getHandler: () => DummyController.prototype[handlerName],
    getClass: () => DummyController,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('DemoGateGuard', () => {
  const reflector = new Reflector();
  const jwt = new JwtService({ secret: 'test-secret' });

  const makeGuard = (gatePassword: string | undefined) => {
    const config = {
      get: (key: string) => (key === 'DEMO_GATE_PASSWORD' ? gatePassword : undefined),
    } as unknown as ConfigService;
    return new DemoGateGuard(jwt, config, reflector);
  };

  it('@Public 라우트는 토큰 없이도 통과한다', () => {
    const guard = makeGuard('sunchak');
    expect(guard.canActivate(makeContext('publicRoute'))).toBe(true);
  });

  it('DEMO_GATE_PASSWORD가 없으면(로컬 기본값) 게이트를 비활성화한다', () => {
    const guard = makeGuard(undefined);
    expect(guard.canActivate(makeContext('protectedRoute'))).toBe(true);
  });

  it('비번이 설정돼 있는데 토큰이 없으면 401', () => {
    const guard = makeGuard('sunchak');
    expect(() => guard.canActivate(makeContext('protectedRoute'))).toThrow(
      UnauthorizedException,
    );
  });

  it('유효한 데모 토큰이면 통과한다', async () => {
    const guard = makeGuard('sunchak');
    const token = await jwt.signAsync({ type: 'demo' });
    expect(
      guard.canActivate(makeContext('protectedRoute', { 'x-demo-token': token })),
    ).toBe(true);
  });

  it('로그인 JWT(type=demo가 아님)는 게이트 토큰으로 쓸 수 없다', async () => {
    const guard = makeGuard('sunchak');
    const loginToken = await jwt.signAsync({ sub: 1, email: 'a@b.com', role: 'USER' });
    expect(() =>
      guard.canActivate(makeContext('protectedRoute', { 'x-demo-token': loginToken })),
    ).toThrow(UnauthorizedException);
  });

  it('다른 시크릿으로 서명된 토큰은 검증 실패로 401', async () => {
    const guard = makeGuard('sunchak');
    const forgedJwt = new JwtService({ secret: 'wrong-secret' });
    const token = await forgedJwt.signAsync({ type: 'demo' });
    expect(() =>
      guard.canActivate(makeContext('protectedRoute', { 'x-demo-token': token })),
    ).toThrow(UnauthorizedException);
  });
});
