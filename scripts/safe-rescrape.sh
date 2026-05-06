#!/bin/bash
# Safely rescrape tenants one at a time, waiting for each to finish.
# Backs off and waits for service recovery if it crashes.

BASE="https://website-context-dwoj.onrender.com"
TENANTS="$@"

if [ -z "$TENANTS" ]; then
  echo "Usage: ./scripts/safe-rescrape.sh tenant1 tenant2 ..."
  exit 1
fi

wait_for_service() {
  local attempts=0
  while true; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health" 2>/dev/null)
    if [ "$code" = "200" ]; then
      return 0
    fi
    attempts=$((attempts + 1))
    if [ $attempts -gt 60 ]; then
      echo "  ✗ Service didn't recover after 5 minutes"
      return 1
    fi
    sleep 5
  done
}

wait_for_tenant() {
  local tid="$1"
  local attempts=0
  while true; do
    resp=$(curl -s "$BASE/api/tenants/$tid/status" 2>/dev/null)
    status=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)

    if [ "$status" = "active" ] || [ "$status" = "error" ]; then
      pages=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('pagesCount',0))" 2>/dev/null)
      chunks=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('chunksCount',0))" 2>/dev/null)
      echo "  → $status ($pages pages, $chunks chunks)"
      return 0
    fi

    # Service might have crashed
    code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health" 2>/dev/null)
    if [ "$code" != "200" ]; then
      echo "  ⚠ Service down, waiting for recovery..."
      wait_for_service || return 1
      # After recovery, re-trigger this tenant
      curl -s -X POST "$BASE/api/admin/rescrape/$tid?maxPages=10" >/dev/null 2>&1
    fi

    attempts=$((attempts + 1))
    if [ $attempts -gt 60 ]; then
      echo "  ✗ Timeout waiting for $tid"
      return 1
    fi
    sleep 10
  done
}

echo "Safe rescrape: ${#} tenant(s)"
echo ""

for tid in $TENANTS; do
  echo "[$tid]"

  # Ensure service is up
  wait_for_service || { echo "  ✗ Skipping (service down)"; continue; }

  # Trigger scrape (maxPages=10 for memory safety)
  curl -s -X POST "$BASE/api/admin/rescrape/$tid?maxPages=10" >/dev/null 2>&1
  echo "  Triggered, waiting..."

  # Wait for completion
  wait_for_tenant "$tid"

  # Cooldown between tenants
  echo "  Cooling down 15s..."
  sleep 15
  echo ""
done

echo "=== DONE ==="
