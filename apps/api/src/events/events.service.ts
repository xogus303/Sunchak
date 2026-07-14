import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  // 이벤트 + 그 재고(Inventory)를 한 번에 생성한다(중첩 생성 = 원자적).
  create(dto: CreateEventDto) {
    return this.prisma.event.create({
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
  }

  // 공개 목록 — 오픈 임박순
  findAll() {
    return this.prisma.event.findMany({
      orderBy: { openAt: 'asc' },
      include: { inventory: true },
    });
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
