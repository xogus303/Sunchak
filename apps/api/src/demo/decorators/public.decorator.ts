import { SetMetadata } from '@nestjs/common';

// @Roles와 같은 패턴 — 라우트/컨트롤러에 이 표식이 있으면 DemoGateGuard가 통과시킨다.
// 게이트 자신(POST /demo/gate)과 헬스체크처럼, 게이트보다 먼저 열려있어야 하는
// 극소수 엔드포인트에만 붙인다.
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
