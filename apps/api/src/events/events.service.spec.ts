import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventsService } from './events.service';
import { PrismaService } from '../prisma/prisma.service';

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

  beforeEach(async () => {
    prisma = {
      event: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
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
    });
  });
});
