import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * @CurrentUser() — 가드가 request.user에 넣어둔 값을 편하게 꺼내는 커스텀 데코레이터.
 * (가드가 통과한 라우트에서만 값이 있다.)
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
