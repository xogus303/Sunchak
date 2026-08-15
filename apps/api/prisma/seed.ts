// 이벤트 목록 화면(2026-08-06 PRD 재검토)용 정적 마감 이벤트 2개를 심는다.
// isDemo:false라 resetDemoEvent()가 절대 건드리지 않는다 — 한 번 만들면 끝,
// "판매중은 데모 이벤트 하나뿐"이라는 그림을 목록에서 보여주기 위한 배경일 뿐이다.
//
// ⚠️ 2026-08-07까지는 여기서 전역 데모 이벤트(isDemo=true, 소유자 없음)도 함께
// 심었는데, 유저별 격리(ADR 0017 개정)로 각 로그인 유저가 자기 전용 데모
// 이벤트를 처음 방문 시 자동으로 갖게 되면서(EventsService.findOrCreateOwnDemoEvent)
// 더 이상 필요 없어져 제거했다 — 이제 데모 이벤트는 seed가 아니라 첫 로그인
// 방문이 만든다.
import { PrismaClient, EventStatus } from '@prisma/client';

const prisma = new PrismaClient();

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
