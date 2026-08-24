import { poissonLikeBatchSize } from './poisson-batch';

// 통계적 성질을 검증하는 테스트라 "항상 정확히 이 값"은 단언할 수 없다 —
// 대신 표본을 충분히 크게(N=3000) 뽑아 평균이 λ 근처에 오는지, 흔들림(분산)이
// 실제로 존재하는지를 확인한다. 표본이 클수록 평균의 표준오차(σ/√N)가 작아져
// 우연히 실패할 확률이 극히 낮아지므로 flaky하지 않다.
describe('poissonLikeBatchSize (대용량 대기열 배치 — 포아송 정규근사)', () => {
  it('remaining이 0이면 0을 반환한다', () => {
    expect(poissonLikeBatchSize(0, 0.2, 50, 1000)).toBe(0);
  });

  it('remaining이 min보다 작으면(대기열 끝물) 남은 인원 전부를 반환한다', () => {
    // λ는 min(50)으로 clamp되지만, 최종적으로 remaining(3)을 넘을 수 없다.
    for (let i = 0; i < 20; i++) {
      expect(poissonLikeBatchSize(3, 0.2, 50, 1000)).toBe(3);
    }
  });

  it('반환값은 항상 remaining을 넘지 않는다', () => {
    for (let i = 0; i < 500; i++) {
      const remaining = Math.floor(Math.random() * 200);
      const result = poissonLikeBatchSize(remaining, 0.2, 50, 1000);
      expect(result).toBeLessThanOrEqual(remaining);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it('반환값은 항상 max를 넘지 않는다', () => {
    for (let i = 0; i < 500; i++) {
      const result = poissonLikeBatchSize(1_000_000, 0.2, 50, 1000);
      expect(result).toBeLessThanOrEqual(1000);
    }
  });

  it('대기열이 충분히 크면(remaining≫max) 평균이 λ(=max로 clamp된 값) 근처로 수렴한다', () => {
    const samples = Array.from({ length: 3000 }, () =>
      poissonLikeBatchSize(1_000_000, 0.2, 50, 1000),
    );
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // λ=1000, 표준오차 ≈ √1000/√3000 ≈ 0.58 — ±30(약 50 표준오차)이면
    // 우연히 벗어날 확률이 사실상 0이라 flaky하지 않다.
    expect(mean).toBeGreaterThan(970);
    expect(mean).toBeLessThan(1030);
  });

  it('같은 조건에서도 매번 똑같은 값이 나오지 않는다(고정 배치가 아니라 흔들린다)', () => {
    const samples = new Set(
      Array.from({ length: 50 }, () => poissonLikeBatchSize(10_000, 0.2, 50, 1000)),
    );
    expect(samples.size).toBeGreaterThan(1);
  });
});
