import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ACCESS_TOKEN_COOKIE, authCookieOptions } from '../common/auth-cookie';

/**
 * 컨트롤러 = HTTP 입구. 요청을 받아 서비스에 넘기고 결과를 응답한다.
 * @Controller('auth') → 이 안의 라우트는 /auth 로 시작한다.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /auth/signup → 기본 201 Created
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  // POST /auth/login → 리소스 생성이 아니므로 200 OK로 명시
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto);
    // 쿠키(브라우저 자동 전송)로도 심는다 — JSON의 accessToken은 curl 등
    // 수동 검증용으로 유지(passthrough:true라 이 return 값이 응답 본문에 그대로 담긴다).
    res.cookie(ACCESS_TOKEN_COOKIE, result.accessToken, authCookieOptions());
    return result;
  }

  // GET /auth/me → 유효한 JWT가 있어야만 접근. 없으면 가드가 401.
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { id: number; email: string; role: string }) {
    return user;
  }

  // POST /auth/logout → JWT는 상태 없는(stateless) 토큰이라 서버가 "무효화"할
  // 방법이 없다(블랙리스트를 따로 두지 않는 한, 이 프로젝트엔 없음). 그래서
  // 로그아웃은 "브라우저가 더 이상 이 토큰을 안 보내게" 쿠키만 지우는 것으로
  // 구현한다 — httpOnly라 프론트 JS(document.cookie)가 못 지우므로 서버가
  // 대신 만료된 쿠키로 덮어써야 한다. 로그인/회원가입과 마찬가지로 JwtAuthGuard는
  // 안 걸어둔다(로그아웃은 "지금 내가 누구인지"를 확인할 필요가 없는, 항상
  // 허용돼야 하는 동작 — 이미 만료된 토큰으로도 눌러야 하니까).
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(ACCESS_TOKEN_COOKIE, authCookieOptions());
    return { loggedOut: true };
  }

  // GET /auth/google → 브라우저를 Google 로그인 페이지로 리다이렉트한다.
  // 핸들러 본문은 실행되지 않는다(가드가 리다이렉트 응답을 먼저 보냄).
  // @Public(): 브라우저의 페이지 이동은 커스텀 헤더(X-Demo-Token)를 못 붙이므로
  // 전역 게이트를 여기서 우회해야 한다(콜백도 마찬가지 — 아래).
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleLogin() {}

  // GET /auth/google/callback → Google이 리다이렉트로 돌아오는 지점.
  // 가드가 GoogleStrategy.validate()까지 실행해 req.user에 우리 User를 담아준다.
  // 여기선 @Res({passthrough:true})가 아니라 @Res() 그대로 받는다 — Nest의
  // 자동 응답 직렬화 대신 res.redirect()로 직접 응답을 끝내야 하므로.
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(@CurrentUser() user: User, @Res() res: Response) {
    const { accessToken } = await this.authService.issueToken(user);
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, authCookieOptions());
    res.redirect(process.env.WEB_APP_URL ?? 'http://localhost:3000');
  }
}
