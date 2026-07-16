#!/usr/bin/env bash
# W2 4전략 k6 벤치마크. 각 전략마다 큰 재고 이벤트를 만들고 동일 부하를 건다.
#
# 사전조건:
#   - 로컬 서버 기동(pnpm start:dev) + 로컬 Postgres(docker-compose) 실행
#   - admin 계정 존재(회원가입 후 DB에서 role=ADMIN 승격). 아래 ADMIN_* 로 지정.
# 사용:
#   ADMIN_EMAIL=admin@sunchak.dev ADMIN_PASSWORD=xxxx VUS=30 DUR=15s bash bench.sh
set -u
B="${BASE_URL:-http://localhost:3001}"
VUS="${VUS:-30}"
DUR="${DUR:-15s}"
STOCK="${STOCK:-200000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@sunchak.dev}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password123}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PG="docker exec sunchak-postgres psql -U sunchak -d sunchak -tAc"
RCLI="docker exec sunchak-redis redis-cli"

TOKEN=$(curl -s -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")
[ -z "$TOKEN" ] && { echo "로그인 실패 — admin 계정/비번 확인"; exit 1; }
echo "VUS=$VUS DUR=$DUR STOCK=$STOCK"

for S in naive pessimistic optimistic atomic redis; do
  echo "================ $S ================"
  curl -s -X POST "$B/events" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
    -d "{\"title\":\"bench-$S\",\"price\":10000,\"openAt\":\"2026-08-01T20:00:00Z\",\"totalQty\":$STOCK}" > /tmp/evb.json
  EID=$(python3 -c "import json;print(json.load(open('/tmp/evb.json'))['id'])")

  # redis 전략은 재고 카운터를 Redis에 심어둔다(정합성: DB 재고와 별도로 관리).
  [ "$S" = "redis" ] && $RCLI SET "stock:event:$EID" "$STOCK" > /dev/null

  k6 run --quiet \
    -e BASE_URL="$B" -e TOKEN="$TOKEN" -e EVENT_ID="$EID" -e STRATEGY="$S" \
    -e VUS="$VUS" -e DURATION="$DUR" \
    --summary-export="/tmp/k6_$S.json" \
    "$DIR/reservations_load.js" > "/tmp/k6_$S.log" 2>&1

  # 차감 후 잔여 재고: redis는 Redis에서, 나머지는 DB inventory에서 읽는다.
  if [ "$S" = "redis" ]; then
    REM=$($RCLI GET "stock:event:$EID")
  else
    REM=$($PG "SELECT \"remainingQty\" FROM inventories WHERE \"eventId\"=$EID;")
  fi
  CNT=$($PG "SELECT count(*) FROM reservations WHERE \"eventId\"=$EID;")
  echo "eventId=$EID  차감량=$((STOCK-REM))  예매행수=$CNT  (예매행수>차감량이면 lost update)"
done

echo
echo "########## 요약 비교 ##########"
python3 - <<'PY'
import json
print(f"{'strategy':<12}{'RPS':>9}{'총요청':>9}{'avg(ms)':>9}{'p95(ms)':>9}{'201':>8}{'409':>8}")
for s in ["naive","pessimistic","optimistic","atomic","redis"]:
    with open(f"/tmp/k6_{s}.json") as f:
        m = json.load(f)["metrics"]
    it = m["iterations"]
    d = m["http_req_duration"]
    print(f"{s:<12}{it['rate']:>9.1f}{it['count']:>9}{d['avg']:>9.1f}{d['p(95)']:>9.1f}"
          f"{m.get('resv_created',{}).get('count',0):>8}{m.get('resv_rejected',{}).get('count',0):>8}")
PY
