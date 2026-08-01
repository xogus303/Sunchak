// 공개 데모 모드(ADR 0016)용 seed — 데모 이벤트(isDemo=true) + 재고가 없으면 만든다.
// 이미 있으면 그대로 둔다(idempotent) — 초기 상태로 되돌리는 건 seed가 아니라
// demo.service.ts의 resetDemoEvent()의 역할.
import { PrismaClient, EventStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
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

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
