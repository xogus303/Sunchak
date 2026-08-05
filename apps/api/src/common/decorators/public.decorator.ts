import { SetMetadata } from '@nestjs/common';

// @Roles와 같은 패턴 — 라우트/컨트롤러에 이 표식이 있으면 전역 게이트 가드
// (DemoGateGuard)가 통과시킨다. 게이트 자신·헬스체크처럼 게이트보다 먼저
// 열려있어야 하는 라우트, 그리고 브라우저가 커스텀 헤더를 못 붙이는 리다이렉트
// 기반 라우트(OAuth 시작/콜백)에 붙인다. demo 모듈 전용이 아니라 앱 전역
// 관심사라 common에 둔다.
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
