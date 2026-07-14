import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * 역할 가드 = "이 라우트에 붙은 @Roles 꼬리표"와 "요청자의 role"을 비교한다.
 * JwtAuthGuard 다음에 실행되어야 request.user가 채워져 있다.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    // 라우트(핸들러)와 컨트롤러에 붙은 @Roles 값을 읽는다.
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // @Roles가 없으면 역할 제한 없는 라우트 → 통과.
    if (!required || required.length === 0) {
      return true;
    }
    const { user } = ctx.switchToHttp().getRequest();
    // 요청자의 role이 요구 목록에 있으면 통과, 아니면 403.
    return required.includes(user?.role);
  }
}
