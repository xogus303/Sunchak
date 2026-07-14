import { ConflictException, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { SignupDto } from './dto/signup.dto';

/**
 * 서비스 = 비즈니스 로직이 사는 곳. 컨트롤러(HTTP)와 분리한다.
 * PrismaService는 @Global이라 여기서 생성자 주입만 하면 바로 쓸 수 있다.
 */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async signup(dto: SignupDto) {
    // 1) 이메일 중복 확인 (email에 UNIQUE 인덱스가 있어 조회가 빠르다)
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('이미 가입된 이메일입니다.');
    }

    // 2) 비밀번호 해싱 — 평문은 절대 저장하지 않는다. argon2는 단방향이라 복호화 불가.
    const passwordHash = await argon2.hash(dto.password);

    // 3) 유저 생성
    const user = await this.prisma.user.create({
      data: { email: dto.email, password: passwordHash },
    });

    // 4) 응답에서 비밀번호 해시는 절대 내보내지 않는다.
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
