import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * @Roles(Role.ADMIN) — 이 라우트에 필요한 역할을 "메타데이터"로 붙인다.
 * SetMetadata(key, value)는 라우트에 꼬리표를 다는 것뿐이고, 실제 판단은 RolesGuard가 한다.
 */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
