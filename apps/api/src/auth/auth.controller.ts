import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';

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
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // GET /auth/me → 유효한 JWT가 있어야만 접근. 없으면 가드가 401.
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { id: number; email: string; role: string }) {
    return user;
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
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(@CurrentUser() user: User) {
    // TODO(프론트 생기면): 토큰을 쿼리파라미터/쿠키로 실어 프론트 URL로
    // 리다이렉트. 지금은 apps/web이 없어 JSON으로 바로 반환(임시, 확인용).
    return this.authService.issueToken(user);
  }
}
