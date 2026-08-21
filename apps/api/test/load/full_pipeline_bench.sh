#!/usr/bin/env bash
# 최종 파이프라인(대기열→HELD→결제) k6 부하 테스트 러너.
# reservations_load.js(W2 5전략)와 달리 지금 실제 사용자가 겪는 흐름 전체를 잰다.
#
# 사용:
#   ADMIN_EMAIL=admin@sunchak.dev ADMIN_PASSWORD=password123 \
#     GATE_PASSWORD=sunchak-demo VUS=150 STOCK=100 bash full_pipeline_bench.sh
set -u
B="${BASE_URL:-http://localhost:3001}"
VUS="${VUS:-100}"
STOCK="${STOCK:-100}"
GATE_PASSWORD="${GATE_PASSWORD:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@sunchak.dev}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password123}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "BASE_URL=$B VUS=$VUS STOCK=$STOCK"

k6 run \
  -e BASE_URL="$B" -e VUS="$VUS" -e STOCK="$STOCK" \
  -e GATE_PASSWORD="$GATE_PASSWORD" \
  -e ADMIN_EMAIL="$ADMIN_EMAIL" -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  --summary-export="/tmp/k6_full_pipeline.json" \
  "$DIR/full_pipeline_load.js"
