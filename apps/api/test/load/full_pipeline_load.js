// 최종 부하 테스트 — 실제 사용자가 지금 겪는 전체 파이프라인을 그대로 재현한다.
// 게이트 통과 → 대기열 입장(ADR 0017) → 입장 허가 대기 → HELD 예매 →
// 결제 접수(ADR 0018). W2 5전략(reservations_load.js)과 달리 대기열/결제가
// 낀 "지금 이 순간의 진짜 흐름"을 측정하는 게 목적이라 별도 파일로 둔다.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const GATE_PASSWORD = __ENV.GATE_PASSWORD || '';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'admin@sunchak.dev';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'password123';
const STOCK = Number(__ENV.STOCK || 300);
const VUS = Number(__ENV.VUS || 30);
// 입장 허가는 2초 주기 배치라, 폴링 횟수*간격이 그보다 넉넉해야 한다.
const MAX_POLL = Number(__ENV.MAX_POLL || 20);
const POLL_INTERVAL_S = Number(__ENV.POLL_INTERVAL_S || 1);

export const options = {
  vus: VUS,
  // 각 VU가 "한 번의 예매 시도"를 온전히 겪게 한다 — 반복 루프가 아니라
  // "동시에 N명이 몰렸을 때"를 재현하는 게 목적.
  iterations: VUS,
  summaryTrendStats: ['avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const admitWaitTrend = new Trend('admit_wait_ms'); // 대기열 입장 ~ 허가까지
const journeyTrend = new Trend('journey_ms'); // 대기열 입장 ~ 결제 접수까지 전체
const admittedCounter = new Counter('admitted');
const soldOutCounter = new Counter('sold_out');
const timeoutCounter = new Counter('admission_timeout');
const paidStartedCounter = new Counter('payment_started');

function uuid() {
  // k6엔 crypto.randomUUID가 없어 v4 형태를 직접 만든다(멱등성 키 용도라 형식만 맞으면 충분).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

// setup()은 부하 시작 전 딱 한 번만 실행된다 — 여기서 테스트용 이벤트와
// VU 수만큼의 "진짜 서로 다른 유저"를 미리 만들어둔다. 대기열 순번·입장
// 허가가 userId 단위라, 유저가 같으면 진짜 경쟁 상황이 재현되지 않는다.
export function setup() {
  let demoToken = '';
  if (GATE_PASSWORD) {
    const gateRes = http.post(
      `${BASE}/demo/gate`,
      JSON.stringify({ password: GATE_PASSWORD }),
      JSON_HEADERS,
    );
    // demo/gate는 @HttpCode 지정이 없어 POST 기본값인 201을 반환한다(login과 달리).
    if (gateRes.status !== 201) {
      throw new Error(`게이트 통과 실패: ${gateRes.status} ${gateRes.body}`);
    }
    demoToken = gateRes.json('demoToken');
  }
  const demoHeader = demoToken ? { 'X-Demo-Token': demoToken } : {};

  const loginRes = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json', ...demoHeader } },
  );
  if (loginRes.status !== 200) {
    throw new Error(`관리자 로그인 실패: ${loginRes.status} ${loginRes.body}`);
  }
  const adminToken = loginRes.json('accessToken');

  const eventRes = http.post(
    `${BASE}/events`,
    JSON.stringify({
      title: `k6-full-pipeline-${Date.now()}`,
      price: 10000,
      openAt: new Date().toISOString(),
      totalQty: STOCK,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        ...demoHeader,
      },
    },
  );
  if (eventRes.status !== 201) {
    throw new Error(`이벤트 생성 실패: ${eventRes.status} ${eventRes.body}`);
  }
  const eventId = eventRes.json('id');

  const users = [];
  for (let i = 0; i < VUS; i++) {
    const email = `k6-load-${Date.now()}-${i}@sunchak.dev`;
    const password = 'password123';
    const signupRes = http.post(
      `${BASE}/auth/signup`,
      JSON.stringify({ email, password }),
      { headers: { 'Content-Type': 'application/json', ...demoHeader } },
    );
    if (signupRes.status !== 201) {
      throw new Error(`유저 생성 실패(${email}): ${signupRes.status} ${signupRes.body}`);
    }
    const userLoginRes = http.post(
      `${BASE}/auth/login`,
      JSON.stringify({ email, password }),
      { headers: { 'Content-Type': 'application/json', ...demoHeader } },
    );
    users.push({ token: userLoginRes.json('accessToken') });
  }

  console.log(`setup 완료: eventId=${eventId} stock=${STOCK} 유저 ${users.length}명`);
  return { demoToken, eventId, users };
}

export default function (data) {
  const user = data.users[(__VU - 1) % data.users.length];
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${user.token}`,
    ...(data.demoToken ? { 'X-Demo-Token': data.demoToken } : {}),
  };

  const journeyStart = Date.now();

  // 1) 대기열 입장
  const joinRes = http.post(`${BASE}/events/${data.eventId}/queue`, null, { headers });
  check(joinRes, { '대기열 입장 202': (r) => r.status === 202 });

  // 2) 입장 허가를 받을 때까지 폴링 — 별도 "상태 조회" API가 없어(SSE만 있음),
  //    실제 예매 시도 자체로 확인한다. 403 = 아직 대기중, 201 = 허가+예매 성공,
  //    409 = 허가는 받았지만 재고 소진.
  let reservationId = null;
  let outcome = 'unknown';
  for (let i = 0; i < MAX_POLL; i++) {
    const res = http.post(
      `${BASE}/events/${data.eventId}/reservations?strategy=held`,
      JSON.stringify({ quantity: 1, idempotencyKey: uuid() }),
      { headers },
    );
    if (res.status === 201) {
      reservationId = res.json('id');
      outcome = 'admitted';
      admitWaitTrend.add(Date.now() - journeyStart);
      admittedCounter.add(1);
      break;
    }
    if (res.status === 409) {
      outcome = 'sold_out';
      soldOutCounter.add(1);
      break;
    }
    if (res.status === 403) {
      sleep(POLL_INTERVAL_S);
      continue;
    }
    outcome = `unexpected_${res.status}`;
    break;
  }
  if (outcome === 'unknown') {
    timeoutCounter.add(1); // MAX_POLL 안에 허가를 못 받음(폭주 시 정상적으로 발생 가능)
  }

  // 3) 결제 접수 — 실제 확정/취소는 비동기(80/20 확률)라 여기선 "접수"까지만 측정.
  //    최종 결과는 Grafana(큐 적체)·DB로 별도 확인한다.
  if (reservationId) {
    const payRes = http.post(
      `${BASE}/reservations/${reservationId}/pay`,
      JSON.stringify({ idempotencyKey: uuid() }),
      { headers },
    );
    check(payRes, { '결제 접수 202': (r) => r.status === 202 });
    if (payRes.status === 202) paidStartedCounter.add(1);
  }

  journeyTrend.add(Date.now() - journeyStart);
}
