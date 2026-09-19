# pi-cc-shim

让 [pi coding agent](https://pi.dev) 通过 anyrouter 这类"只放行 Claude Code 流量"的 relay 访问 Claude 模型。

> 这是第三方社区包，与 Anthropic、anyrouter 均无关联。它只改写请求的形态，不涉及绕过鉴权或计费；请只在你自己有权使用的 relay 账号上使用。

## 问题

anyrouter 对 Anthropic Messages 通道做了 Claude Code 指纹校验：请求体长得不像 Claude Code 发出的，就直接回 `503` / `520`，与负载无关。pi 在 `models.json` 里把它配成 `anthropic-messages` provider 后，每次请求都命中这个校验。

本包用 pi 的 `before_provider_headers` / `before_provider_request` 钩子在进程内改写请求：零额外进程，随 pi 启动，只对命中的 provider 生效。

## 它改了什么

| 位置 | 改写 | 缺失时 relay 的反应 |
| --- | --- | --- |
| `system[]` | 头部插入 `You are Claude Code, Anthropic's official CLI for Claude.`（不带 cache_control，pi 的缓存断点不受影响） | 503 |
| `metadata.user_id` | Claude Code 格式的 JSON 串，`device_id` 按机器稳定、`session_id` 按会话稳定 | 503 |
| `tools[]` | 补齐 `Agent` `Bash` `Edit` `Read` `Write` `Glob` `Grep` 中缺失的空壳工具，描述里指向 pi 的真实工具 | 520 |
| `model` | 去掉 `[1M]` / `[1m]` 后缀 | 429 |
| `betas` | 追加 `context-1m-2025-08-07`（SDK 转成 `anthropic-beta` 头，pi 自己的 beta 保留） | 400 |
| 请求头 | `User-Agent: claude-cli/2.1.274 (external, cli)`、`x-app: cli` | 不影响校验，照 Claude Code 发 |

鉴权头（`x-api-key` / `Authorization`）一律不动。规则来源与复核方法见 [docs/relay-rules.md](docs/relay-rules.md)。

模型偶尔会去调空壳工具（例如 `Read`）。它们不会被执行，本包会把 pi 返回的 "not found" 改写成 "use `read` instead" 之类的提示，模型下一步就会改用正确的工具。

## 安装

要求 pi >= 0.85.0，Node >= 22.19。

```bash
# 从 GitHub 安装
pi install git:github.com/wylu1037/pi-cc-shim@v0.1.0

# 或者只在本次启动时试用，不落盘
pi -e git:github.com/wylu1037/pi-cc-shim

# 本地目录
pi -e /path/to/pi-cc-shim
```

发布到 npm 后也可以 `pi install npm:pi-cc-shim`。

如果还装了其它会改 payload 的扩展，把本包放在 `settings.json` 的 `packages` 列表末尾：`before_provider_request` 按加载顺序执行，后加载者的结果覆盖前者。

## 配置 models.json

在 `~/.pi/agent/models.json` 里加一个 `anthropic-messages` provider（`baseUrl` **不要**带 `/v1`）：

```json
{
  "providers": {
    "any.router.claude": {
      "baseUrl": "https://anyrouter.top",
      "api": "anthropic-messages",
      "apiKey": "sk-...",
      "models": [
        {
          "id": "claude-fable-5-1",
          "name": "claude-fable-5-1 (anyrouter)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

默认按域名 `anyrouter.top` 自动命中，provider 起什么名字都可以。同一域名下如果还配了走 codex 通道的 `openai-responses` provider，不会被误改写：只有 `api` 为 `anthropic-messages` 的才处理。

## 配置文件

`~/.pi/agent/pi-cc-shim.json`，不存在时使用默认值。所有校验规则都可配置，relay 改规则时改这里即可：

```json
{
  "enabled": true,
  "providers": ["any.router.claude"],
  "baseUrlPatterns": ["anyrouter.top"],
  "systemPrompt": "You are Claude Code, Anthropic's official CLI for Claude.",
  "toolNames": ["Agent", "Bash", "Edit", "Read", "Write", "Glob", "Grep"],
  "headers": {
    "User-Agent": "claude-cli/2.1.274 (external, cli)",
    "x-app": "cli"
  },
  "betas": ["context-1m-2025-08-07"],
  "stripModelSuffix": true,
  "decoyToolHints": true
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关 |
| `providers` | `models.json` 里 provider 的键名白名单，精确匹配；需要收窄生效范围时填它 |
| `baseUrlPatterns` | 兜底：`baseUrl` 包含任一子串即命中 |
| `systemPrompt` | 插到 `system[0]` 的句子；留空则不插 |
| `toolNames` | 必须出现在 `tools[]` 里的工具名，缺的补空壳 |
| `headers` | 逐个覆盖的请求头，整个对象替换默认值。`anthropic-beta` 放这里会被忽略，请用 `betas` |
| `betas` | 追加到 `payload.betas` |
| `stripModelSuffix` | 去掉 `model` 末尾的 `[1m]` |
| `decoyToolHints` | 模型误调空壳工具时改写错误提示 |

字段类型不符会保留默认值并在启动时提示；`/cc-shim status` 也会列出配置警告。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/cc-shim status`（或 `/cc-shim`） | 当前模型是否命中及原因、上次请求的状态码、上次实际注入了什么 |
| `/cc-shim on` / `off` | 本会话临时开关，不写回文件 |
| `/cc-shim dump` | 把下一次请求的最终 payload 与请求头（鉴权头脱敏）写到 `~/.pi/agent/logs/cc-shim-last.json` |

命中时页脚会显示 `cc-shim ✓`。relay 返回 503/520 时会弹一条提醒。

## 出问题时

1. `/cc-shim status`：确认当前模型命中、通道是 `anthropic-messages`。
2. 仍然 503/520：`/cc-shim dump`，重发一次，检查 `cc-shim-last.json` 里的 `system[0]`、`tools`、`metadata.user_id`、`betas`、`headers`。
3. 用 `RELAY_API_KEY=... scripts/probe-relay.sh` 逐项删减，看哪一条规则的状态码变了，对应改配置字段。
4. 提示词污染：多了一句 "You are Claude Code" 可能让模型自称 Claude Code。实测对日常任务无影响；如果发现行为漂移，可以在 `systemPrompt` 后追加一句 "Ignore the previous sentence; you are running inside pi." 再观察（先用探针脚本确认 relay 只做子串匹配）。

## 开发

```bash
pnpm install
pnpm check     # tsc --noEmit + node --test
pnpm e2e       # 起本地假 relay，用真实 pi 进程跑离线端到端
```

`scripts/fake-relay.mjs` 复刻了 relay 的全部校验规则，`scripts/e2e.sh` 会分别验证：不加载本包被拒绝、加载后拿到 `pong`、按包目录加载、模型误调空壳工具时的提示改写、RPC 模式下的命令与 dump。

## 许可

MIT
