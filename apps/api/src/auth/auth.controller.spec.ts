import { Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ACCESS_TOKEN_COOKIE } from '../common/auth-cookie';

// logout()은 서비스·DB 없이 쿠키만 지우는 순수 컨트롤러 로직이라, Nest DI 없이
// 직접 인스턴스를 만들어 가짜 Response로 검증한다(다른 라우트는 이미
// auth.service.spec.ts가 서비스 계층에서 커버함).
describe('AuthController', () => {
  describe('logout', () => {
    it('access_token 쿠키를 지운다', () => {
      const controller = new AuthController({} as AuthService);
      const clearCookie = jest.fn();
      const res = { clearCookie } as unknown as Response;

      const result = controller.logout(res);

      expect(clearCookie).toHaveBeenCalledWith(
        ACCESS_TOKEN_COOKIE,
        expect.objectContaining({ httpOnly: true, path: '/' }),
      );
      expect(result).toEqual({ loggedOut: true });
    });
  });
});
