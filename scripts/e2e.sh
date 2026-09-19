#!/usr/bin/env bash
# 离线端到端：起假 relay，用临时 agent 目录跑真实的 pi 进程。
# 预期：不加载 shim 时被 503 拒绝；加载 shim 后拿到 "pong"。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
TMP="$(mktemp -d)"
RELAY_LOG="$TMP/relay.log"
RELAY_PID=""
cleanup() {
	if [ -n "$RELAY_PID" ]; then kill "$RELAY_PID" 2>/dev/null || true; wait "$RELAY_PID" 2>/dev/null || true; fi
	rm -rf "$TMP"
}
trap cleanup EXIT

PORT="$PORT" node "$ROOT/scripts/fake-relay.mjs" 2>"$RELAY_LOG" &
RELAY_PID=$!
for _ in $(seq 1 50); do
	curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
	sleep 0.1
done

cat >"$TMP/models.json" <<JSON
{
  "providers": {
    "fake.relay": {
      "baseUrl": "http://127.0.0.1:$PORT",
      "api": "anthropic-messages",
      "apiKey": "fake-key",
      "models": [
        {
          "id": "claude-fable-5-1[1m]",
          "name": "claude-fable-5-1 (fake relay)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
JSON
cat >"$TMP/settings.json" <<'JSON'
{
  "defaultProvider": "fake.relay",
  "defaultModel": "claude-fable-5-1[1m]",
  "quietStartup": true,
  "retry": { "enabled": false }
}
JSON
cat >"$TMP/pi-cc-shim.json" <<'JSON'
{ "providers": ["fake.relay"] }
JSON

# 用法：run_pi <prompt> [pi 额外参数...]
run_pi() {
	local prompt="$1"
	shift
	PI_CODING_AGENT_DIR="$TMP" pi -p --no-session --offline -ne -ns -np -nc "$@" "$prompt" </dev/null 2>&1 || true
}

echo "== 1. 不加载 shim（预期被假 relay 拒绝）"
OUT_OFF="$(run_pi "Reply with exactly: pong")"
echo "$OUT_OFF" | tail -n 3

echo "== 2. 以文件方式加载 shim（预期 pong）"
OUT_ON="$(run_pi "Reply with exactly: pong" -e "$ROOT/extensions/cc-shim.ts")"
echo "$OUT_ON" | tail -n 3

echo "== 3. 以包目录方式加载 shim（预期 pong）"
OUT_DIR="$(run_pi "Reply with exactly: pong" -e "$ROOT")"
echo "$OUT_DIR" | tail -n 3

echo "== 4. 模型误调诱饵工具 Read（预期 toolResult 被改写成指向 read 的提示）"
OUT_DECOY="$(run_pi "call-decoy" -e "$ROOT/extensions/cc-shim.ts")"
echo "$OUT_DECOY" | tail -n 3

echo "== 5. RPC 模式：命令、dump 落盘、状态记录"
OUT_RPC="$(PI_CODING_AGENT_DIR="$TMP" node "$ROOT/scripts/e2e-rpc.mjs" "$ROOT/extensions/cc-shim.ts" 2>&1 || true)"
echo "$OUT_RPC"

echo "== relay 日志"
cat "$RELAY_LOG"

STATUS=0
if ! grep -q "pong" <<<"$OUT_ON"; then echo "FAIL: 加载 shim 后未得到 pong"; STATUS=1; fi
if grep -q "pong" <<<"$OUT_OFF"; then echo "FAIL: 未加载 shim 也通过了，假 relay 校验未生效"; STATUS=1; fi
if ! grep -q "pong" <<<"$OUT_DIR"; then echo "FAIL: 按包目录加载 shim 后未得到 pong"; STATUS=1; fi
if ! grep -q "placeholder injected by pi-cc-shim" <<<"$OUT_DECOY"; then echo "FAIL: 诱饵工具的 toolResult 未被改写"; STATUS=1; fi
if ! grep -q 'Call `read` instead' <<<"$OUT_DECOY"; then echo "FAIL: 提示未指向 pi 的 read 工具"; STATUS=1; fi
if ! grep -q "RPC e2e PASS" <<<"$OUT_RPC"; then echo "FAIL: RPC 场景未通过"; STATUS=1; fi
if ! grep -q "] 200 ok" "$RELAY_LOG"; then echo "FAIL: relay 日志里没有 200"; STATUS=1; fi
[ "$STATUS" -eq 0 ] && echo "PASS"
exit "$STATUS"
