import { ForbiddenException } from '@nestjs/common';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { QueueService } from '../queue/queue.service';

// 순수 오케스트레이션(strategy=held일 때만 대기열 입장 허가를 요구하는 것, ADR 0017)
// 검증이라 실제 DB·Redis가 필요 없다 — 두 협력자를 모두 mock한 단위 테스트.
describe('ReservationsController (단위 — 대기열 연동)', () => {
  const reservationsService = { create: jest.fn() } as unknown as ReservationsService;
  const queueService = { assertAdmitted: jest.fn() } as unknown as QueueService;
  let controller: ReservationsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new ReservationsController(reservationsService, queueService);
  });

  it('strategy=held면 assertAdmitted를 먼저 통과해야 create를 호출한다', async () => {
    (queueService.assertAdmitted as jest.Mock).mockResolvedValue(undefined);
    (reservationsService.create as jest.Mock).mockResolvedValue({ id: 1 });

    await controller.create(1, { id: 7 }, { quantity: 1, idempotencyKey: 'k' }, 'held');

    expect(queueService.assertAdmitted).toHaveBeenCalledWith(1, 7);
    expect(reservationsService.create).toHaveBeenCalledWith(1, 7, 1, 'held', 'k');
  });

  it('strategy=held인데 입장 허가가 없으면 create를 호출하지 않고 그대로 던진다', async () => {
    (queueService.assertAdmitted as jest.Mock).mockRejectedValue(
      new ForbiddenException('대기열 입장 후 이용하세요.'),
    );

    await expect(
      controller.create(1, { id: 7 }, { quantity: 1 }, 'held'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reservationsService.create).not.toHaveBeenCalled();
  });

  it('strategy가 held가 아니면(W2 벤치마크용) 대기열 체크 없이 곧바로 create를 호출한다', async () => {
    (reservationsService.create as jest.Mock).mockResolvedValue({ id: 2 });

    await controller.create(1, { id: 7 }, { quantity: 1 }, 'atomic');

    expect(queueService.assertAdmitted).not.toHaveBeenCalled();
    expect(reservationsService.create).toHaveBeenCalledWith(1, 7, 1, 'atomic', undefined);
  });
});
