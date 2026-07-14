import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * 가드 = 라우트 앞의 문지기. 컨트롤러에 닿기 전에 통과 여부를 결정한다.
 * AuthGuard('jwt') → 위 JwtStrategy를 돌려 유효한 토큰이 없으면 401을 던진다.
 * @UseGuards(JwtAuthGuard)를 라우트에 붙여 사용한다.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
