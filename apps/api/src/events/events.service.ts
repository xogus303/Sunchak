import { Injectable, NotFoundException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreateEventDto } from './dto/create-event.dto';

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // 이벤트 + 그 재고(Inventory)를 한 번에 생성한다(중첩 생성 = 원자적).
  //
  // ⚠️ 'held' 예매 전략(ReservationsService.createHeld)은 DB가 아니라 Redis의
  // stock:event:{id} 키를 DECRBY해서 재고를 차감한다. 이 키를 여기서 안 심으면,
  // ReconcileProcessor가 1분 주기로 재계산해 채워주기 전까지는 키가 아예 없는
  // 상태다 — DECRBY가 없는 키를 0으로 취급해 무조건 음수가 되면서 실제 재고가
  // 남아 있어도 모든 예매가 "재고가 부족합니다"로 실패한다(2026-08-07, 유저별
  // 데모 이벤트 자동 생성 도입 중 실측으로 발견 — 새 이벤트가 생성 직후 60초
  // 안에 예매되면 100% 이 버그를 밟는다).
  async create(dto: CreateEventDto) {
    const event = await this.prisma.event.create({
      data: {
        title: dto.title,
        description: dto.description,
        price: dto.price,
        openAt: new Date(dto.openAt),
        // 1:1 관계라 이벤트를 만들며 재고 행도 같이 만든다. remainingQty는 처음엔 total과 같음.
        inventory: {
          create: { totalQty: dto.totalQty, remainingQty: dto.totalQty },
        },
      },
      include: { inventory: true }, // 응답에 재고도 함께 포함
    });
    await this.redis.set(`stock:event:${event.id}`, dto.totalQty);
    return event;
  }

  // 로그인한 유저 전용 데모 이벤트(2026-08-07, 유저별 격리) + 정적 마감 이벤트만
  // 보여준다 — 예전엔 isDemo:true인 이벤트 1개를 모든 방문자가 공유해서, 한
  // 사람이 리셋/가상유저투입을 하면 동시에 테스트 중인 다른 사람 데이터까지
  // 건드렸다. 방문할 때마다 "내 것"이 없으면 그 자리에서 만들어(findOrCreate)
  // 항상 존재를 보장한다.
  async findAll(userId: number) {
    await this.findOrCreateOwnDemoEvent(userId);
    return this.prisma.event.findMany({
      where: { OR: [{ isDemo: false }, { demoOwnerId: userId }] },
      orderBy: { openAt: 'asc' },
      include: { inventory: true },
    });
  }

  // demoOwnerId가 @unique라 유저당 최대 1개만 존재할 수 있다 — DemoService의
  // reset/simulate/stats가 전부 이 메서드로 "내 데모 이벤트"를 얻는다.
  async findOrCreateOwnDemoEvent(userId: number) {
    const existing = await this.prisma.event.findUnique({
      where: { demoOwnerId: userId },
      include: { inventory: true },
    });
    if (existing) return existing;

    const created = await this.prisma.event.create({
      data: {
        title: '선착순 데모 콘서트',
        description: 'Sunchak 공개 데모용 이벤트 — 자유롭게 예매해보세요.',
        price: 10000,
        openAt: new Date(),
        status: EventStatus.ON_SALE,
        isDemo: true,
        demoOwnerId: userId,
        inventory: { create: { totalQty: 100, remainingQty: 100 } },
      },
      include: { inventory: true },
    });
    // create()와 동일한 이유로 필요 — 여기서 안 심으면 방금 만든 데모 이벤트가
    // 60초 동안 "예매하기"를 눌러도 전부 재고 부족으로 실패한다.
    await this.redis.set(`stock:event:${created.id}`, 100);
    return created;
  }

  // 공개 상세 — 없으면 404
  async findOne(id: number) {
    const event = await this.prisma.event.findUnique({
      where: { id },
      include: { inventory: true },
    });
    if (!event) {
      throw new NotFoundException('이벤트를 찾을 수 없습니다.');
    }
    return event;
  }
}
