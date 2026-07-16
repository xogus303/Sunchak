// W2 동시성 부하 스크립트 — 한 이벤트(재고 행)에 예매 요청을 쏟아붓는다.
// 실행: bench.sh 가 환경변수를 주입해 전략별로 호출한다.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const TOKEN = __ENV.TOKEN;
const EVENT_ID = __ENV.EVENT_ID;
const STRATEGY = __ENV.STRATEGY || 'atomic';

const created = new Counter('resv_created'); // 201 개수
const rejected = new Counter('resv_rejected'); // 409 개수

export const options = {
  vus: Number(__ENV.VUS || 30),
  duration: __ENV.DURATION || '15s',
  summaryTrendStats: ['avg', 'p(95)', 'p(99)', 'max'],
};

const params = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
  },
};
const body = JSON.stringify({ quantity: 1 });

export default function () {
  const res = http.post(
    `${BASE}/events/${EVENT_ID}/reservations?strategy=${STRATEGY}`,
    body,
    params,
  );
  if (res.status === 201) created.add(1);
  else if (res.status === 409) rejected.add(1);
  check(res, { '201 or 409': (r) => r.status === 201 || r.status === 409 });
}
