# anyrouter 对 Claude Code 流量的校验规则（实测记录）

> 实测日期：2026-09-18，方法：本地代理抓取 Claude Code 真实请求 → 原样重放通过 → 逐项删减。
> relay 规则随时可能变化。每次发版前用 `scripts/probe-relay.sh` 复核一遍，并在文末变更记录里补一行。

## 校验项

| 位置 | 要求 | 缺失/不符时 | pi-cc-shim 对应配置 |
| --- | --- | --- | --- |
| `system[]` | 至少一个 text block 含 `You are Claude Code, Anthropic's official CLI for Claude.` | 503 | `systemPrompt` |
| `metadata.user_id` | Claude Code 的 JSON 串：`{"device_id":"<64 hex>","account_uuid":"","session_id":"<uuid>"}`，值可伪造 | 503 | 自动生成 |
| `tools[]` | **至少 4 个**，且名字必须是 Claude Code 的真实工具名（`Agent` `Bash` `Edit` `Read` `Write` `Glob` `Grep` …）；`description` / `input_schema` 可以是空壳 | 520 | `toolNames` |
| `model` | `claude-fable-5-1`，**不能带** `[1M]` 后缀 | 429 | `stripModelSuffix` |
| 头 `anthropic-beta` | 必须含 `context-1m-2025-08-07` | 400 "请启用 1m 上下文后重试" | `betas` |

与 pi 直接相关的两个细节：

- pi 内置工具名是小写的 `read` `bash` `edit` `write` `grep` `find` `ls`，relay 不认（实测 7 个小写名 → 520）；小写工具 + 4 个 Claude Code 工具名混在一起可以通过（实测 200）。
- pi 的 system prompt 不含 Claude Code 开场句，需要在 payload 层补一个 block。

以下项目实测**不影响**校验：`stream`、`thinking`、`output_config`、`max_tokens`、`x-stainless-*` 头、`?beta=true`、`claude-code-20250219` 等其它 beta 头、`Authorization: Bearer` 与 `x-api-key` 的选择、`User-Agent`（Claude Code 的 UA 建议照发，但不是必要条件）。

## 复核方法

`scripts/probe-relay.sh` 用 curl 发送最小可通过的请求，并按下表逐项删减；哪一行的实际状态码与预期不符，就说明对应规则变了。

| 变体 | 改动 | 预期状态码 |
| --- | --- | --- |
| `baseline` | 完整最小请求 | 200 |
| `no-system` | 开场句换成普通句子 | 503 |
| `no-metadata` | 去掉 `metadata` | 503 |
| `few-tools` | 只保留 2 个 Claude Code 工具 | 520 |
| `model-1m` | `model` 带 `[1M]` 后缀 | 429 |
| `no-beta` | 去掉 `anthropic-beta` 头 | 400 |

```bash
RELAY_API_KEY=sk-xxx scripts/probe-relay.sh            # 跑全部变体
RELAY_API_KEY=sk-xxx scripts/probe-relay.sh baseline   # 只跑一个
RELAY_BASE_URL=https://other.relay RELAY_MODEL=claude-opus-5 RELAY_API_KEY=... scripts/probe-relay.sh
```

规则变了之后的处理：只需改默认配置就能修复的（例如新的 beta 名、新的工具名）发 patch 版本；需要新增改写逻辑的发 minor 版本。用户不必等发版，先改 `~/.pi/agent/pi-cc-shim.json` 即可。

## 变更记录

| 日期 | 结论 |
| --- | --- |
| 2026-09-18 | 首次实测，得到上表 |
