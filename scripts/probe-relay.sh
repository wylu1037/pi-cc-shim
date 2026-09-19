#!/usr/bin/env bash
# 向 relay 发送最小可通过 Claude Code 指纹校验的请求，并按变体逐项删减，定位是哪条规则变了。
# 变体与预期见 docs/relay-rules.md。
#
# 用法：
#   RELAY_API_KEY=sk-xxx scripts/probe-relay.sh            # 跑全部变体
#   RELAY_API_KEY=sk-xxx scripts/probe-relay.sh baseline   # 只跑指定变体（可多个）
# 环境变量：
#   RELAY_BASE_URL  默认 https://anyrouter.top（不要带 /v1）
#   RELAY_MODEL     默认 claude-fable-5-1
#   RELAY_AUTH      api-key（默认，发 x-api-key）或 bearer（发 Authorization: Bearer）
set -euo pipefail

BASE_URL="${RELAY_BASE_URL:-https://anyrouter.top}"
MODEL="${RELAY_MODEL:-claude-fable-5-1}"
AUTH="${RELAY_AUTH:-api-key}"
: "${RELAY_API_KEY:?请设置 RELAY_API_KEY}"

CC_SENTENCE="You are Claude Code, Anthropic's official CLI for Claude."
BETA="context-1m-2025-08-07"

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi
}
DEVICE_ID="$(printf '%s' "$(hostname):${USER:-unknown}" | sha256)"
SESSION_ID="$( (uuidgen 2>/dev/null || printf 'probe-%s' "$(date +%s)") | tr '[:upper:]' '[:lower:]')"
USER_ID="{\"device_id\":\"$DEVICE_ID\",\"account_uuid\":\"\",\"session_id\":\"$SESSION_ID\"}"
USER_ID_ESC="${USER_ID//\"/\\\"}"

tool() { printf '{"name":"%s","description":"","input_schema":{"type":"object","properties":{}}}' "$1"; }
tools_json() {
	local out="" name
	for name in "$@"; do out="${out:+$out,}$(tool "$name")"; done
	printf '[%s]' "$out"
}

# 输出：payload<TAB>是否带 beta 头
build_variant() {
	local variant="$1"
	local system="[{\"type\":\"text\",\"text\":\"$CC_SENTENCE\"}]"
	local metadata=",\"metadata\":{\"user_id\":\"$USER_ID_ESC\"}"
	local tools model="$MODEL" with_beta=1
	tools="$(tools_json Agent Bash Edit Read)"
	case "$variant" in
		baseline) ;;
		no-system) system='[{"type":"text","text":"You are a helpful assistant."}]' ;;
		no-metadata) metadata="" ;;
		few-tools) tools="$(tools_json Agent Bash)" ;;
		model-1m) model="${MODEL}[1M]" ;;
		no-beta) with_beta=0 ;;
		*) echo "未知变体：$variant（可用：baseline no-system no-metadata few-tools model-1m no-beta）" >&2; return 2 ;;
	esac
	printf '{"model":"%s","max_tokens":16,"stream":false,"system":%s,"messages":[{"role":"user","content":"Reply with exactly: pong"}],"tools":%s%s}\t%s' \
		"$model" "$system" "$tools" "$metadata" "$with_beta"
}

expected_status() {
	case "$1" in
		baseline) echo 200 ;;
		no-system | no-metadata) echo 503 ;;
		few-tools) echo 520 ;;
		model-1m) echo 429 ;;
		no-beta) echo 400 ;;
	esac
}

probe() {
	local variant="$1" built payload with_beta body code expected
	built="$(build_variant "$variant")"
	payload="${built%%$'\t'*}"
	with_beta="${built##*$'\t'}"
	body="$(mktemp)"

	local headers=(-H "content-type: application/json" -H "anthropic-version: 2023-06-01" -H "user-agent: claude-cli/2.1.274 (external, cli)" -H "x-app: cli")
	[ "$with_beta" = 1 ] && headers+=(-H "anthropic-beta: $BETA")
	if [ "$AUTH" = bearer ]; then headers+=(-H "authorization: Bearer $RELAY_API_KEY"); else headers+=(-H "x-api-key: $RELAY_API_KEY"); fi

	code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$BASE_URL/v1/messages?beta=true" "${headers[@]}" --data "$payload" || echo 000)"
	expected="$(expected_status "$variant")"
	if [ "$code" = "$expected" ]; then
		printf '%-12s %s（符合预期）\n' "$variant" "$code"
	else
		printf '%-12s %s（预期 %s）  <-- 规则可能已变\n' "$variant" "$code" "$expected"
		head -c 300 "$body"; echo
	fi
	rm -f "$body"
}

if [ "$#" -eq 0 ]; then
	set -- baseline no-system no-metadata few-tools model-1m no-beta
fi
echo "relay: $BASE_URL  model: $MODEL  auth: $AUTH"
for variant in "$@"; do probe "$variant"; done
