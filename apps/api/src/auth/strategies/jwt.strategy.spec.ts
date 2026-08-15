import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';

// 2026-08-08 실사용 중 발견 — JWT 서명·만료만 검증하면, 개발 중 jest가 DB를
// 통째로 비운 뒤에도 브라우저에 남은 예전 쿠키가 "유효한 인증"으로 통과해
// 이후 demoOwnerId FK 위반 등 원인 모를 500으로 이어졌다. validate()가 DB로
// 유저 존재를 한 번 더 확인하는지 검증한다.
describe('JwtStrategy', () => {
  const config = { get: () => 'test-secret' } as unknown as ConfigService;
  let prisma: { user: { findUnique: jest.Mock } };
  let strategy: JwtStrategy;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
    strategy = new JwtStrategy(config, prisma as unknown as PrismaService);
  });

  const payload = { sub: 1, email: 'a@test.local', role: 'USER' };

  it('토큰의 유저가 DB에 실재하면 request.user 모양을 반환한다', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 1, email: 'a@test.local' });

    await expect(strategy.validate(payload)).resolves.toEqual({
      id: 1,
      email: 'a@test.local',
      role: 'USER',
    });
  });

  it('토큰은 유효하지만 그 유저가 DB에 없으면 401을 던진다', async () => {
    prisma.user.findUnique.mockResolvedValue(null); // DB 초기화 등으로 유저가 사라진 경우

    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
