import { Test } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

// argon2 모듈 전체를 가짜로 대체. 실제 해싱/검증 대신 우리가 반환값을 정한다.
// (우리가 테스트할 건 argon2가 아니라 login/signup의 판단 로직이므로)
jest.mock('argon2');

describe('AuthService', () => {
  let service: AuthService;
  // 가짜 prisma/jwt — 서비스가 호출하는 메서드만 jest.fn()으로 흉내낸다.
  let prisma: { user: { findUnique: jest.Mock; create: jest.Mock } };
  let jwt: { signAsync: jest.Mock };

  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn(), create: jest.fn() } };
    jwt = { signAsync: jest.fn() };

    // NestJS 테스트용 미니 모듈: 진짜 PrismaService/JwtService 자리에 가짜를 끼운다(useValue).
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('login', () => {
    it('존재하지 않는 이메일이면 401을 던진다', async () => {
      prisma.user.findUnique.mockResolvedValue(null); // 유저 없음

      await expect(
        service.login({ email: 'nope@x.com', password: 'pw' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('비밀번호가 틀리면 401을 던진다', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        email: 'a@x.com',
        password: 'stored-hash',
        role: 'USER',
      });
      (argon2.verify as jest.Mock).mockResolvedValue(false); // 대조 실패

      await expect(
        service.login({ email: 'a@x.com', password: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('이메일과 비밀번호가 맞으면 accessToken을 반환한다', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        email: 'a@x.com',
        password: 'stored-hash',
        role: 'USER',
      });
      (argon2.verify as jest.Mock).mockResolvedValue(true); // 대조 성공
      jwt.signAsync.mockResolvedValue('signed.jwt.token');

      const result = await service.login({ email: 'a@x.com', password: 'pw' });

      expect(result).toEqual({ accessToken: 'signed.jwt.token' });
      // payload에 최소 식별정보만 담겼는지도 함께 확인
      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: 1,
        email: 'a@x.com',
        role: 'USER',
      });
    });

    it('Google로 가입해 password가 null인 계정은 비번 로그인 시 401(크래시 아님)', async () => {
      jest.clearAllMocks(); // 이전 테스트들의 argon2.verify 호출 기록을 지운다
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        email: 'google-user@x.com',
        password: null, // Google 계정
        role: 'USER',
      });

      await expect(
        service.login({ email: 'google-user@x.com', password: 'anything' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(argon2.verify).not.toHaveBeenCalled(); // null과 비교 시도조차 안 함
    });
  });

  describe('findOrCreateGoogleUser', () => {
    const profile = { emails: [{ value: 'google-user@x.com', verified: true }] } as any;

    it('이미 같은 이메일의 유저가 있으면 그대로 반환한다(새로 안 만듦)', async () => {
      const existing = { id: 5, email: 'google-user@x.com', password: null, role: 'USER' };
      prisma.user.findUnique.mockResolvedValue(existing);

      const result = await service.findOrCreateGoogleUser(profile);

      expect(result).toBe(existing);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('처음 보는 이메일이면 password=null로 새 유저를 만든다', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 6,
        email: 'google-user@x.com',
        password: null,
        role: 'USER',
      });

      await service.findOrCreateGoogleUser(profile);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { email: 'google-user@x.com', password: null },
      });
    });

    it('Google 프로필에 이메일이 없으면 401을 던진다', async () => {
      await expect(
        service.findOrCreateGoogleUser({ emails: [] } as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('signup', () => {
    it('이미 가입된 이메일이면 409를 던진다', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, email: 'a@x.com' });

      await expect(
        service.signup({ email: 'a@x.com', password: 'pw12345678' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('정상 가입 시 비밀번호 해시를 응답에 포함하지 않는다', async () => {
      prisma.user.findUnique.mockResolvedValue(null); // 중복 아님
      (argon2.hash as jest.Mock).mockResolvedValue('hashed-pw');
      prisma.user.create.mockResolvedValue({
        id: 1,
        email: 'a@x.com',
        role: 'USER',
        createdAt: new Date('2026-01-01'),
        password: 'hashed-pw', // DB엔 해시가 있지만
      });

      const result = await service.signup({
        email: 'a@x.com',
        password: 'pw12345678',
      });

      expect(result).not.toHaveProperty('password'); // 응답엔 없어야 한다
      expect(result.email).toBe('a@x.com');
    });
  });
});
