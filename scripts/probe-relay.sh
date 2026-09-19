#!/usr/bin/env bash
# Send the minimal request that passes the relay's Claude Code fingerprint check, then drop one rule per variant to find which rule changed.
#
# Variants and the status expected while the relay's rules are unchanged (observed on anyrouter, 2026-09-18):
#   baseline     full minimal request                    200
#   no-system    opener replaced by a plain sentence     503
#   no-metadata  metadata removed                        503
#   few-tools    only 2 Claude Code tool names           520
#   model-1m     model carries a [1M] suffix             429
#   no-beta      anthropic-beta header removed           400
#
# Usage:
#   RELAY_API_KEY=sk-xxx scripts/probe-relay.sh            # run all variants
#   RELAY_API_KEY=sk-xxx scripts/probe-relay.sh baseline   # run only the given variants (one or more)
# Environment:
#   RELAY_BASE_URL  default https://anyrouter.top (no /v1 suffix)
#   RELAY_MODEL     default claude-fable-5-1
#   RELAY_AUTH      api-key (default, sends x-api-key) or bearer (sends Authorization: Bearer)
set -euo pipefail

BASE_URL="${RELAY_BASE_URL:-https://anyrouter.top}"
MODEL="${RELAY_MODEL:-claude-fable-5-1}"
AUTH="${RELAY_AUTH:-api-key}"
: "${RELAY_API_KEY:?set RELAY_API_KEY}"

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

# Output: payload<TAB>whether to send the beta header
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
		*) echo "unknown variant: $variant (available: baseline no-system no-metadata few-tools model-1m no-beta)" >&2; return 2 ;;
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
		printf '%-12s %s (as expected)\n' "$variant" "$code"
	else
		printf '%-12s %s (expected %s)  <-- rule may have changed\n' "$variant" "$code" "$expected"
		head -c 300 "$body"; echo
	fi
	rm -f "$body"
}

if [ "$#" -eq 0 ]; then
	set -- baseline no-system no-metadata few-tools model-1m no-beta
fi
echo "relay: $BASE_URL  model: $MODEL  auth: $AUTH"
for variant in "$@"; do probe "$variant"; done
