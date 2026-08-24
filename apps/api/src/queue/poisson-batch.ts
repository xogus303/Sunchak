// 대용량 이벤트 입장 허가 배치 크기를 "매 틱 정확히 같은 값"이 아니라, 포아송
// 과정을 정규분포로 근사해 평균 근처에서 자연스럽게 흔들리는 값으로 계산한다
// (ADR 0016 백로그 — 대용량 트래픽 대응, 캐주얼 데모의 고정 배치와는 별개).
// 논의 배경: 많은 독립적인 사람이 각자 무작위 순간에 도착하면, 합산된 도착
// 수는 저절로 평균 근처에 몰리고 끝값은 드물어진다 — 우리가 그렇게 "설계"한
// 게 아니라 독립 사건을 합치면 자연히 나오는 모양이라, 이걸 그대로 흉내낸다.

// Box-Muller 변환 — Math.random()이 주는 균등분포(0~1) 난수 2개를 표준정규분포
// (평균 0, 표준편차 1) 난수 1개로 바꾼다. u1이 0이면 log(0)=-Infinity가 되므로
// Number.EPSILON을 하한으로 둬 방지한다.
function randomStandardNormal(): number {
  const u1 = Math.max(Math.random(), Number.EPSILON);
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * 이번 틱에 대기열에서 뺄 인원 수를 계산한다.
 *
 * - 평균(λ)은 남은 인원의 meanFraction 비율로 잡되 [min, max] 사이로 자른다
 *   (대기열이 아주 크면 한 틱에 너무 많이 빼가지 않도록, 아주 작으면 λ가
 *   0에 가까워 정규분포 근사가 깨지지 않도록).
 * - 실제 값은 포아송의 정규근사(평균 λ, 표준편차 √λ)로 뽑는다 — λ가 작을 땐
 *   이 근사가 부정확하지만, 최종적으로 [min, max]로 다시 자르고 남은 인원을
 *   넘지 않게 하므로(대기열 끝물은 사실상 "남은 사람 전부") 실사용엔 문제없다.
 */
export function poissonLikeBatchSize(
  remaining: number,
  meanFraction: number,
  min: number,
  max: number,
): number {
  if (remaining <= 0) return 0;

  const lambda = Math.min(Math.max(remaining * meanFraction, min), max);
  const raw = Math.round(lambda + Math.sqrt(lambda) * randomStandardNormal());
  const clamped = Math.min(Math.max(raw, min), max);

  return Math.min(clamped, remaining);
}
