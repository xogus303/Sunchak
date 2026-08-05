import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { User } from '@prisma/client';
import { Profile } from 'passport-google-oauth20';
import { PrismaService } from '../prisma/prisma.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

/**
 * 서비스 = 비즈니스 로직이 사는 곳. 컨트롤러(HTTP)와 분리한다.
 * PrismaService(@Global)와 JwtService(AuthModule에서 등록)를 생성자 주입받는다.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async signup(dto: SignupDto) {
    // 이메일 중복 확인 (email에 UNIQUE 인덱스가 있어 조회가 빠르다)
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('이미 가입된 이메일입니다.');
    }

    // 비밀번호 해싱 — 평문 저장 금지. argon2는 단방향이라 복호화 불가.
    const passwordHash = await argon2.hash(dto.password);

    const user = await this.prisma.user.create({
      data: { email: dto.email, password: passwordHash },
    });

    // 비밀번호 해시는 응답에서 제외
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  async login(dto: LoginDto) {
    // 1) 이메일로 유저 조회
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // 보안: "이메일 없음"과 "비번 틀림"을 구분해 노출하지 않는다(동일 메시지).
    // password가 null인 경우(Google로 가입한 계정)도 같은 메시지로 거부한다 —
    // "이 이메일은 Google 계정입니다" 같은 힌트를 주면 계정 존재 여부가 샌다.
    if (!user || !user.password) {
      throw new UnauthorizedException(
        '이메일 또는 비밀번호가 올바르지 않습니다.',
      );
    }

    // 2) 저장된 해시와 입력 비번 대조 (복호화가 아니라 재해싱 비교)
    const valid = await argon2.verify(user.password, dto.password);
    if (!valid) {
      throw new UnauthorizedException(
        '이메일 또는 비밀번호가 올바르지 않습니다.',
      );
    }

    return this.issueToken(user);
  }

  /**
   * Google 로그인 콜백에서 호출된다. 이메일로 기존 유저를 찾거나(이미 이메일/
   * 비번으로 가입했던 계정이어도 재사용), 없으면 password=null로 새로 만든다.
   */
  async findOrCreateGoogleUser(profile: Profile): Promise<User> {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      throw new UnauthorizedException(
        'Google 계정에서 이메일을 가져올 수 없습니다.',
      );
    }

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      return existing;
    }
    return this.prisma.user.create({ data: { email, password: null } });
  }

  /** login()과 Google 콜백이 공유하는 JWT 발급 로직. */
  async issueToken(user: User) {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwt.signAsync(payload);
    return { accessToken };
  }
}
