// 공개 데모 모드(ADR 0016)용 seed — 데모 이벤트(isDemo=true) + 재고가 없으면 만든다.
// 이미 있으면 그대로 둔다(idempotent) — 초기 상태로 되돌리는 건 seed가 아니라
// demo.service.ts의 resetDemoEvent()의 역할.
//
// 이벤트 목록 화면(2026-08-06 PRD 재검토)용 정적 마감 이벤트 2개도 함께 심는다.
// isDemo:false라 resetDemoEvent()가 절대 건드리지 않는다 — 한 번 만들면 끝,
// "판매중은 데모 이벤트 하나뿐"이라는 그림을 목록에서 보여주기 위한 배경일 뿐이다.
import { PrismaClient, EventStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function seedDemoEvent() {
  const existing = await prisma.event.findFirst({ where: { isDemo: true } });
  if (existing) {
    console.log(`데모 이벤트가 이미 있습니다 (id=${existing.id}) — 건너뜀.`);
    return;
  }

  const event = await prisma.event.create({
    data: {
      title: '선착순 데모 콘서트',
      description: 'Sunchak 공개 데모용 이벤트 — 자유롭게 예매해보세요.',
      price: 10000,
      openAt: new Date(),
      status: EventStatus.ON_SALE,
      isDemo: true,
      inventory: { create: { totalQty: 100, remainingQty: 100 } },
    },
  });
  console.log(`데모 이벤트 생성 완료 (id=${event.id}).`);
}

async function seedClosedEvent(title: string, description: string, price: number) {
  const existing = await prisma.event.findFirst({ where: { title } });
  if (existing) {
    console.log(`마감 이벤트가 이미 있습니다 (${title}) — 건너뜀.`);
    return;
  }

  await prisma.event.create({
    data: {
      title,
      description,
      price,
      openAt: new Date('2026-06-01T20:00:00.000Z'), // 이미 지난 오픈 시각(장식용)
      status: EventStatus.SOLD_OUT,
      isDemo: false,
      inventory: { create: { totalQty: 50, remainingQty: 0 } },
    },
  });
  console.log(`마감 이벤트 생성 완료 (${title}).`);
}

async function main() {
  await seedDemoEvent();
  await seedClosedEvent(
    '얼리버드 재즈 나이트',
    '이미 매진된 재즈 공연 — 이벤트 목록 화면에서 "판매중은 하나뿐"임을 보여주는 장식용.',
    15000,
  );
  await seedClosedEvent(
    '여름밤 인디 페스티벌',
    '이미 매진된 페스티벌 — 이벤트 목록 화면에서 "판매중은 하나뿐"임을 보여주는 장식용.',
    22000,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
