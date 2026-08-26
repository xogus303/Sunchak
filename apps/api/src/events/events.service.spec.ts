import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
      findUniqueOrThrow: jest.Mock;
    };
  };
  let redis: { set: jest.Mock };

  beforeEach(async () => {
    prisma = {
      event: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
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

  describe('findOrCreateOwnLoadTestEvent', () => {
    it('이미 내 대용량 테스트 이벤트가 있으면 totalQty를 무시하고 그대로 반환한다', async () => {
      const existing = { id: 6, loadTestOwnerId: 1, isDemo: true };
      prisma.event.findUnique.mockResolvedValue(existing);

      await expect(
        service.findOrCreateOwnLoadTestEvent(1, 9999),
      ).resolves.toBe(existing);
      expect(prisma.event.create).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('없으면 지정한 totalQty로 새로 만들고, isDemo:true로 표시해 공개 목록에서 숨긴다', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      const created = { id: 8, loadTestOwnerId: 1, isDemo: true };
      prisma.event.create.mockResolvedValue(created);

      await expect(
        service.findOrCreateOwnLoadTestEvent(1, 5000),
      ).resolves.toBe(created);
      // 핵심: loadTestOwnerId로 소유자를 못박고, isDemo:true라야 findAll()의
      // "isDemo:false 또는 demoOwnerId:내id" 필터 어느 쪽에도 안 걸려 일반
      // 방문자·다른 유저에게 안 보인다.
      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            loadTestOwnerId: 1,
            isDemo: true,
            inventory: { create: { totalQty: 5000, remainingQty: 5000 } },
          }),
        }),
      );
      expect(redis.set).toHaveBeenCalledWith('stock:event:8', 5000);
    });

    // 2026-08-26 브라우저 e2e로 발견 — /load-test 진입 시 stats 스트림과 "내
    // 예매" 대기열 입장이 동시에 이 메서드를 처음 호출하면, 둘 다 "없으니
    // 만들자"로 판단해 동시에 create()를 시도해 loadTestOwnerId 유니크
    // 제약(P2002)에서 진 쪽이 500으로 죽었다. reservations.service.ts의
    // createHeld() 재전송 처리와 같은 패턴으로 고쳤다 — 회귀 테스트.
    it('동시에 두 요청이 생성을 시도해 유니크 제약(P2002)에 걸리면, 이긴 쪽이 만든 행을 다시 조회해 반환한다', async () => {
      prisma.event.findUnique.mockResolvedValue(null); // 조회 시점엔 아직 없었음
      prisma.event.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );
      const winnersEvent = { id: 8, loadTestOwnerId: 1, isDemo: true };
      prisma.event.findUniqueOrThrow.mockResolvedValue(winnersEvent);

      await expect(
        service.findOrCreateOwnLoadTestEvent(1, 5000),
      ).resolves.toBe(winnersEvent);
      // 진 쪽은 500을 던지지 않고, 이긴 쪽이 만든 행을 loadTestOwnerId로 재조회한다.
      expect(prisma.event.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({ where: { loadTestOwnerId: 1 } }),
      );
      // 진 쪽은 Redis 재고 키를 심으면 안 된다 — 이긴 쪽이 이미 정확한
      // totalQty로 심어놨는데, 진 쪽이 자기 totalQty(5000)로 덮어쓰면 두
      // 요청의 totalQty가 다를 때 재고가 틀어질 수 있다.
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('P2002가 아닌 다른 에러는 그대로 던진다', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      const otherError = new Error('DB 연결 끊김');
      prisma.event.create.mockRejectedValue(otherError);

      await expect(
        service.findOrCreateOwnLoadTestEvent(1, 5000),
      ).rejects.toBe(otherError);
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
