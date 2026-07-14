import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';

/**
 * 컨트롤러 = HTTP 입구. 요청을 받아 서비스에 넘기고 결과를 응답한다.
 * @Controller('auth') → 이 안의 라우트는 /auth 로 시작한다.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /auth/signup
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }
}
