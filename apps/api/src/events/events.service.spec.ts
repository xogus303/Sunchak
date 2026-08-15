import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventsService } from './events.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

describe('EventsService', () => {
  let service: EventsService;
  // 서비스가 호출하는 event 메서드만 가짜로 흉내낸다.
  let prisma: {
    event: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
  };
  let redis: { set: jest.Mock };

  beforeEach(async () => {
    prisma = {
      event: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    redis = { set: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(EventsService);
  });

  describe('findOne', () => {
    it('이벤트가 없으면 404를 던진다', async () => {
      prisma.event.findUnique.mockResolvedValue(null); // 조회 결과 없음

      await expect(service.findOne(999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('이벤트가 있으면 그대로 반환한다', async () => {
      const event = {
        id: 1,
        title: '콘서트',
        inventory: { totalQty: 10, remainingQty: 10 },
      };
      prisma.event.findUnique.mockResolvedValue(event);

      await expect(service.findOne(1)).resolves.toBe(event);
    });
  });

  describe('create', () => {
    it('재고를 전체 수량과 동일하게 초기화해 생성한다', async () => {
      prisma.event.create.mockResolvedValue({ id: 1 });
      const dto = {
        title: '콘서트',
        description: '설명',
        price: 50000,
        openAt: '2026-08-01T10:00:00.000Z',
        totalQty: 100,
      };

      await service.create(dto);

      // 핵심: remainingQty(남은 재고)가 totalQty(전체)와 같게 심겨야 한다.
      // (W2 동시성 실험의 출발점 — 처음엔 전량 판매 가능)
      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inventory: { create: { totalQty: 100, remainingQty: 100 } },
          }),
        }),
      );
      // 핵심: 'held' 예매 전략은 DB가 아니라 이 Redis 키를 DECRBY해서 재고를
      // 차감한다(2026-08-07) — 안 심으면 새 이벤트는 ReconcileProcessor가
      // 1분 주기로 재계산해주기 전까지 모든 예매가 재고 부족으로 실패한다.
      expect(redis.set).toHaveBeenCalledWith('stock:event:1', 100);
    });
  });

  describe('findOrCreateOwnDemoEvent', () => {
    it('이미 내 데모 이벤트가 있으면 새로 만들지 않고 그대로 반환한다', async () => {
      const existing = { id: 5, demoOwnerId: 1, isDemo: true };
      prisma.event.findUnique.mockResolvedValue(existing);

      await expect(service.findOrCreateOwnDemoEvent(1)).resolves.toBe(
        existing,
      );
      expect(prisma.event.create).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('내 데모 이벤트가 없으면 재고 100/100짜리를 새로 만들어 반환한다', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      const created = { id: 7, demoOwnerId: 1, isDemo: true };
      prisma.event.create.mockResolvedValue(created);

      await expect(service.findOrCreateOwnDemoEvent(1)).resolves.toBe(
        created,
      );
      // 핵심: demoOwnerId로 소유자를 못박아야 유저별 격리가 성립한다
      // (2026-08-07) — 이게 빠지면 데모 이벤트가 다시 전역 공유로 돌아간다.
      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            demoOwnerId: 1,
            isDemo: true,
            inventory: { create: { totalQty: 100, remainingQty: 100 } },
          }),
        }),
      );
      // 이것도 안 심으면 같은 재고 부족 버그를 밟는다.
      expect(redis.set).toHaveBeenCalledWith('stock:event:7', 100);
    });
  });

  describe('findAll', () => {
    it('마감 이벤트와 내 데모 이벤트만 필터링해서 조회한다', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 5, demoOwnerId: 1 }); // 이미 내 데모 이벤트가 있는 상황
      prisma.event.findMany.mockResolvedValue([]);

      await service.findAll(1);

      // 핵심: isDemo:false(마감 이벤트, 모두 공개) 또는 demoOwnerId:내 id
      // (내 전용 데모)만 보여준다 — 다른 사람의 데모 이벤트는 안 보여야 한다.
      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ isDemo: false }, { demoOwnerId: 1 }] },
        }),
      );
    });

    it('내 데모 이벤트가 없으면 조회 전에 먼저 만든다', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      prisma.event.create.mockResolvedValue({ id: 9, demoOwnerId: 1 });
      prisma.event.findMany.mockResolvedValue([]);

      await service.findAll(1);

      expect(prisma.event.create).toHaveBeenCalled();
    });
  });
});
