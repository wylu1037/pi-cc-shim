# pi-cc-shim 设计文档

> 让 pi coding agent 通过 anyrouter 这类"只放行 Claude Code 流量"的 relay 访问 Claude 模型。
>
> 状态：已实现（2026-09-19，基于 pi 0.85.1）。与最初设计的出入见第 8 节"实现核对记录"。

## 1. 背景与问题

anyrouter 对 Anthropic Messages 通道做了 **Claude Code 指纹校验**：请求 body 长得不像 Claude Code 发出的，就直接回 `503 / 520 Service Unavailable`，和负载无关。pi 在 `models.json` 里把 anyrouter 配成 `anthropic-messages` provider 后，每次请求都命中这个校验，所以稳定 503。

### 1.1 已实测的校验规则

通过本地代理抓取 Claude Code 真实请求、原样重放通过、再逐项删减，得到的最小集合如下（2026-09-18 实测，relay 规则未来可能变化）：

| 位置 | 要求 | 缺失/不符时 |
| --- | --- | --- |
| `system[]` | 至少一个 text block 含 `You are Claude Code, Anthropic's official CLI for Claude.` | 503 |
| `metadata.user_id` | Claude Code 的 JSON 串格式：`{"device_id":"<64 hex>","account_uuid":"","session_id":"<uuid>"}`，值可伪造 | 503 |
| `tools[]` | **至少 4 个**，且名字必须是 Claude Code 的真实工具名（`Agent` `Bash` `Edit` `Read` `Write` `Glob` `Grep` …），`description` / `input_schema` 可以是空壳 | 520 |
| `model` | `claude-fable-5-1`，**不能带** `[1M]` 后缀 | 429 |
| 头 `anthropic-beta` | 必须含 `context-1m-2025-08-07` | 400 "请启用 1m 上下文后重试" |

与 pi 直接相关的两个细节：

- pi 内置工具名是小写的 `read` `bash` `edit` `write` `grep` `find` `ls`，**relay 不认**（实测 7 个小写名 → 520）。但小写工具 + 4 个 Claude Code 工具名混在一起可以通过（实测 200）。
- pi 的 system prompt 不含 Claude Code 开场句，需要在 payload 层补一个 block。

以下项目实测**不影响**校验：`stream`、`thinking`、`output_config`、`max_tokens`、`x-stainless-*` 头、`?beta=true`、`claude-code-20250219` 等其他 beta 头、`Authorization: Bearer` 与 `x-api-key` 的选择、`User-Agent`（Claude Code 的 UA 建议照发，但不是必要条件）。

规则的可复核版本维护在 `docs/relay-rules.md`，配套 `scripts/probe-relay.sh`。

## 2. 方案选型

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| A. 本地 HTTP 代理 | 起一个 localhost 代理改写请求，`models.json` 的 `baseUrl` 指向它 | 客户端无关，但多一个常驻进程、要管端口和生命周期，pi 之外的场景才值得 |
| B. **pi 扩展包** | 用 pi 的 `before_provider_headers` + `before_provider_request` 钩子在进程内改写 | 零额外进程，随 pi 启动，可按 provider 精确生效，可通过 `pi install` 分发。**采用** |
| C. 改 `models.json` 的 `headers` | 只能改头 | 校验主要在 body，不够 |

pi 0.85.1 提供的钩子（`docs/extensions.md`，签名以 `dist/core/extensions/types.d.ts` 为准）：

- `before_provider_headers`：原地改 `event.headers`（`Record<string, string | null>`），`null` 删除，返回值被忽略。每个 provider 请求触发一次，重试复用同一份头。
- `before_provider_request`：`event.payload` 是已序列化的 provider 请求体（`unknown`），返回非 `undefined` 即替换；多个扩展按加载顺序串行。
- `after_provider_response`：拿到 `status` / `headers`。**只在 HTTP 成功时触发**：Anthropic SDK 对非 2xx 直接抛 `APIError`，pi-ai 的 `onResponse` 回调在其后，所以 503/520 到不了这个钩子（见 8.3）。
- `message_end`：可用 `{ message }` 替换刚结束的消息（user / assistant / toolResult 都会触发）。用于两处兜底（见 3.2）。
- `ctx.model`：`Model<any> | undefined`，含 `provider` / `api` / `baseUrl` / `id` / `name`，用于判断是否生效。
- `ctx.sessionManager.getSessionId()`：作为 `metadata.user_id.session_id`。
- `getAgentDir()`（从 `@earendil-works/pi-coding-agent` 导入）：配置与日志路径的根，尊重 `PI_CODING_AGENT_DIR`。

## 3. 架构

```
pi 主循环
  └─ 一次 provider 请求
     ├─ before_provider_headers ──► [shim] 命中？
     │                                 ├─ User-Agent → claude-cli/<ver> (external, cli)
     │                                 └─ x-app: cli              （大小写不敏感覆盖，旧写法置 null）
     ├─ before_provider_request ──► [shim] 命中？
     │                                 ├─ model: 去掉 [1M] / [1m] 后缀
     │                                 ├─ system: 头部插入 Claude Code 开场句 block
     │                                 ├─ tools: 追加缺失的 Claude Code 工具名（空壳）
     │                                 ├─ metadata.user_id: 生成 CC 格式 JSON 串
     │                                 └─ betas: 追加 context-1m-2025-08-07（SDK 合成 anthropic-beta 头）
     ├─ after_provider_response ──► [shim] 记录成功状态码（只有 2xx 会到这里）
     └─ message_end ─────────────► [shim] assistant.stopReason === "error" → 解析状态码，503/520 时提醒
                                   [shim] toolResult 是误调的空壳工具 → 改写成指向真实工具的提示
```

### 3.1 生效条件（如何判断命中 provider）

三个钩子的事件对象本身都**不带** model 信息，判断依据来自第二个参数 `ctx.model`。实测钩子触发时 `ctx.model` 的值形如：

```json
{
  "provider": "orca.router",
  "api": "openai-responses",
  "baseUrl": "https://api.orcarouter.ai/v1",
  "id": "deepseek/deepseek-v4-flash-free",
  "name": "deepseek-v4-flash"
}
```

对应关系：`provider` 就是 `models.json` 里 `providers` 下的**键名**（用户自己起的，如 `any.router.2`），`api` / `baseUrl` 原样来自该 provider 的配置，`id` 来自 `models[].id`。`ProviderId` 类型是 `KnownProvider | string`，自定义名字不会被过滤。

判定（`src/matcher.ts` 的 `TargetMatcher`，三个钩子与命令共用），顺序固定：会话开关 → 有模型 → 通道是 `anthropic-messages` → `providers` 白名单精确匹配 → `baseUrlPatterns` 子串兜底。每个分支都返回带原因的 `MatchResult`，`/cc-shim status` 直接展示原因。

| 方式 | 依据 | 适用 |
| --- | --- | --- |
| `providers` 白名单 | `ctx.model.provider === "any.router.claude"` | 用户明确知道要对哪个 provider 生效；同一域名下有多个 provider 但只想改其中一个 |
| `baseUrlPatterns` 域名匹配 | `ctx.model.baseUrl.includes("anyrouter.top")` | 零配置开箱即用；用户给 provider 起了任意名字也能命中 |

默认配置 `providers: []`、`baseUrlPatterns: ["anyrouter.top"]`，装上即生效；需要收窄时再填 `providers`。

注意事项：

- `api` 判断放在最前面。同一个 anyrouter 域名在 `models.json` 里可能同时配了 `openai-responses`（走 codex 通道）和 `anthropic-messages` 两个 provider，只有后者需要改写。
- 一次请求内 headers 钩子与 request 钩子先后触发、看到同一个 `ctx.model`，不需要缓存判定结果；只有请求头改写摘要需要暂存到 request 钩子里并入同一条注入记录。
- `/model` 切换后 `ctx.model` 立即变化，无需监听 `model_select`；本包监听它只是为了刷新页脚状态。
- `before_provider_headers` 里的 `event.headers` 已经包含 `models.json` 该 provider 的 `headers` 与 pi 的归因头（8.2）。同名头可能以不同大小写出现（例如用户配了 `user-agent`），而 pi-ai 后续用 `Object.assign` 区分大小写地合并，所以覆盖时要把其它写法显式置 `null`，只保留一个规范写法。

### 3.2 各字段改写细则

**model**：`/\[1m\]$/i` 去掉。1M 上下文改由 beta 声明，这与 Claude Code 自身行为一致。

**system**：pi 序列化后的 `system` 正常是 block 数组（无 system prompt 时缺失），其它扩展可能改成字符串，统一转成数组后在 index 0 插入：

```json
{ "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude." }
```

不带 `cache_control`，避免打乱 pi 原有的缓存断点；pi 自己的 system prompt block 原样保留在后面。已存在完全相同的块时不重复插入（OAuth 模式下 pi 自己会插这一句）。

**tools**：检查现有 `tools[].name`，补齐到默认清单 `["Agent","Bash","Edit","Read","Write","Glob","Grep"]` 中缺失的项，追加在末尾（pi 把 `cache_control` 放在自己最后一个工具上，前插会打乱缓存前缀）。追加的空壳工具：

```json
{
  "name": "Read",
  "description": "Unavailable in this environment. Use the `read` tool instead.",
  "input_schema": { "type": "object", "properties": {} }
}
```

描述里的替代工具按"小写同名 → 别名表（`Glob` → `find`/`ls`）"从 payload 里的真实工具中挑选；没有可替代的（如 `Agent`）写 "Do not call it."。

风险：模型可能真的去调 `Read`。两层缓解：

- description 明确说不可用并指向 pi 的同名小写工具；
- 模型仍然调用时，pi 的 agent loop 先按名字查表，查不到就直接产出 `Tool Read not found` 的错误结果，**不会触发 `tool_call` 钩子**（8.4）。所以兜底放在 `message_end`：命中"本扩展上一次请求追加的名字 + `isError`"的 toolResult，把内容改写成 "`Read` is a compatibility placeholder injected by pi-cc-shim and cannot be executed. Call `read` instead."，模型下一步就会改用正确工具。替代工具来自 `pi.getActiveTools()`。

如果 pi 请求里没有 `tools` 字段（例如纯问答无工具模式），则新建数组。

**metadata.user_id**：

```json
{ "device_id": "<sha256(hostname:username) 的 hex>", "account_uuid": "", "session_id": "<ctx.sessionManager.getSessionId()>" }
```

`device_id` 按机器稳定，`session_id` 按会话稳定，模拟真实 Claude Code 的行为。如果 pi 已经带了 `metadata`，只覆盖 `user_id`。

**betas 与请求头**：

| 项 | 处理 |
| --- | --- |
| `anthropic-beta` | **不走请求头**。pi-ai 一旦在请求头里看到 `anthropic-beta`，就把它当作完整 beta 列表并放弃自己动态算出的 beta（interleaved-thinking、fine-grained-tool-streaming 等），会改变模型行为。改为追加到 `payload.betas`：它已含 pi 的 beta，SDK 发请求时用 `betas.toString()` 合成 `anthropic-beta` 头（8.5） |
| `User-Agent` | 覆盖为 `claude-cli/2.1.274 (external, cli)`（可配置） |
| `x-app` | 设为 `cli` |

不动鉴权头，`x-api-key` / `Authorization` 沿用 pi 的配置。

### 3.3 配置

配置文件 `<agentDir>/pi-cc-shim.json`（默认 `~/.pi/agent/pi-cc-shim.json`，不存在则用默认值）：

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

所有校验规则都可配置，relay 改规则时用户改 JSON 即可，不必等发版。与最初草案的差异：`userAgent` 泛化为 `headers`（relay 新增任何头校验都只需改配置），`blockDecoyToolCalls` 改名 `decoyToolHints`（机制从"拦截"变成"改写提示"，见 3.2）。

加载策略：表驱动校验，字段类型不符则保留默认值并记录警告；未知字段警告；`headers` 里的 `anthropic-beta` 被剔除并提示改用 `betas`。警告在启动时 notify 一次，`/cc-shim status` 也会列出。配置错误绝不让扩展整体失效。

### 3.4 命令与状态

| 命令 | 作用 |
| --- | --- |
| `/cc-shim status`（无参数等价） | 当前 model 是否命中及原因、配置来源与警告、上一次响应的状态码（成功来自 `after_provider_response`，失败来自 assistant 错误消息）、上一次实际注入的逐项摘要 |
| `/cc-shim on` / `off` | 本会话临时开关；`session_start` 时重置为配置值 |
| `/cc-shim dump` | 武装一次性记录器：下一次请求在 headers 钩子暂存请求头，在 request 钩子把最终 payload 一起写到 `<agentDir>/logs/cc-shim-last.json`。`authorization` / `x-api-key` 等鉴权头脱敏；未命中的请求也会记录（`applied: false`）以便排查"为什么没生效" |

页脚状态：命中显示 `cc-shim ✓`，会话内关闭显示 `cc-shim off`，其余隐藏。relay 返回 503/520 时弹一条提醒，每个状态码只提醒一次，收到成功响应后复位（避免 pi 重试期间刷屏）。

## 4. 实现

### 4.1 目录结构

```
pi-cc-shim/
├── package.json                 # pi 清单：extensions: ["./extensions"]
├── pnpm-workspace.yaml          # 拒绝 pi 传递依赖的 build 脚本（pnpm 11 的 allowBuilds）
├── tsconfig.json                # noEmit + erasableSyntaxOnly，源码可被 Node 直接剥离类型运行
├── README.md / LICENSE
├── extensions/
│   └── cc-shim.ts               # 唯一入口：组合根，只做装配与钩子接线
├── src/                         # 纯逻辑，不依赖 pi 运行时（只有 type import）
│   ├── types.ts                 # AnthropicPayload / ModelLike / ProviderHeaders 最小类型
│   ├── config.ts                # 默认值、路径、表驱动校验与加载
│   ├── matcher.ts               # TargetMatcher：命中判定与原因
│   ├── payload.ts               # PayloadRule 责任链：model / system / tools / metadata / betas
│   ├── headers.ts               # HeaderRewriter：大小写不敏感覆盖
│   ├── identity.ts              # device_id / user_id
│   ├── safeguards.ts            # 状态码解析、拒绝判定、诱饵工具提示
│   ├── dump.ts                  # DumpRecorder：一次性脱敏快照
│   ├── state.ts                 # 会话态
│   └── commands.ts              # /cc-shim 子命令表与 status 文本
├── docs/
│   ├── pi-cc-shim-design.md     # 本文
│   └── relay-rules.md           # 校验规则实测记录 + 复核方法
├── scripts/
│   ├── probe-relay.sh           # curl 最小请求，逐项删减定位规则变化（回归）
│   ├── fake-relay.mjs           # 复刻校验规则的本地假 relay（离线 e2e）
│   ├── e2e.sh                   # 起假 relay，用真实 pi 进程跑 5 个场景
│   └── e2e-rpc.mjs              # RPC 模式驱动命令、dump 与状态断言
└── test/                        # node --test 单元测试
    ├── payload.test.ts  matcher.test.ts  headers.test.ts  config.test.ts
    ├── safeguards.test.ts  dump.test.ts  commands.test.ts
```

为什么辅助模块放 `src/` 而不是 `extensions/`：pi 对 `extensions/` 目录的发现规则是"每个直接的 `.ts` / `.js` 文件都当作一个扩展加载"，没有默认导出工厂函数的文件会报错。`extensions/*/index.ts` 子目录形式也可以，但 `src/` 与入口分离更清楚。

### 4.2 package.json

```json
{
  "name": "pi-cc-shim",
  "version": "0.1.0",
  "description": "Make pi requests pass Claude Code fingerprint checks on relays like anyrouter",
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "anthropic", "claude-code", "relay", "anyrouter"],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/wylu1037/pi-cc-shim.git" },
  "packageManager": "pnpm@11.24.0",
  "engines": { "node": ">=22.19.0" },
  "files": ["extensions", "src", "scripts", "docs/relay-rules.md", "README.md", "LICENSE"],
  "pi": { "extensions": ["./extensions"] },
  "scripts": {
    "test": "node --test \"test/**/*.test.ts\"",
    "typecheck": "tsc --noEmit",
    "check": "pnpm typecheck && pnpm test",
    "e2e": "bash scripts/e2e.sh"
  },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.85.1",
    "@types/node": "^26.6.1",
    "typescript": "^5.9.3"
  }
}
```

`peerDependencies` 按 pi 文档写 `"*"`（pi 安装包时禁用 peer 解析，宿主提供这些模块）；devDependencies 里固定一个版本只为类型检查。无运行时依赖。

### 4.3 模块职责与用到的模式

| 模块 | 职责 | 模式 / 原则 |
| --- | --- | --- |
| `payload.ts` | 每条校验规则一个 `PayloadRule`（`apply(payload, ctx) → { payload, summary? }`），`PayloadRewriter` 顺序执行并收集摘要；`createPayloadRewriter(config)` 只把打开的规则装进链 | 责任链 / 策略；开闭原则：relay 新增校验 = 新增一条规则；规则是纯函数，浅拷贝不改入参 |
| `matcher.ts` | `TargetMatcher.evaluate(model, enabled) → MatchResult{matched, reason, detail}` | 规约式判定，原因即输出，status 不需要重复推导 |
| `headers.ts` | `setHeader` 大小写不敏感覆盖，`HeaderRewriter` 批量应用并产出摘要 | 单一职责 |
| `config.ts` | 默认值 + `FIELD_KINDS` 表驱动校验 + `loadConfig(path, read?)` | 依赖注入（文件读取可替换）；容错优先 |
| `dump.ts` | `DumpRecorder.arm() → captureHeaders() → captureRequest()` 一次性快照，写入函数可注入 | 依赖注入；把跨两个钩子的状态封装起来 |
| `safeguards.ts` | `extractHttpStatus`、`isRelayRejection`、`buildDecoyHint` | 纯函数 |
| `commands.ts` | `SUBCOMMANDS` 表 + `createShimCommand(deps)`；`formatStatus` 纯函数 | 命令模式（分发表），依赖通过 `CommandDeps` 注入 |
| `state.ts` | 会话态数据与 `resetSessionState` | 无逻辑的数据结构 |
| `extensions/cc-shim.ts` | 读配置、构造上述对象、注册 6 个钩子和 1 个命令 | 组合根；除接线外不含业务逻辑 |

代码约束：不用 `enum`、参数属性等需要转译的 TS 语法（`erasableSyntaxOnly`），源码同时被 pi 的 jiti 和 Node 原生类型剥离直接执行；相对导入写全 `.ts` 后缀。

### 4.4 测试

- **单元**（`pnpm test`，58 例）：规则链覆盖 system 为字符串 / 数组 / 缺失 / 幂等；tools 缺失 / 部分重叠 / 已齐全 / 替代工具推荐；model 带 `[1M]` `[1m]` 或不带；metadata 已存在时只覆盖 `user_id`；betas 追加去重；入参不被修改；关闭开关后规则不进链。另有 matcher、headers（大小写变体置 null）、config（ENOENT / 非法 JSON / 类型不符 / 未知字段 / `anthropic-beta` 剔除）、safeguards、dump、commands。
- **离线端到端**（`pnpm e2e`）：`scripts/fake-relay.mjs` 复刻 1.1 的全部校验并返回最小 SSE 流；`scripts/e2e.sh` 用临时 `PI_CODING_AGENT_DIR` 与真实 `pi` 进程验证：不加载本包 → 503；`-e extensions/cc-shim.ts` → `pong`；`-e <包目录>` → `pong`；模型误调 `Read` → toolResult 被改写为指向 `read` 的提示；RPC 模式下 `/cc-shim status|dump|off|on` 与 dump 文件内容（改写项、脱敏）逐项断言。
- **集成（手动，需要 relay 账号）**：`pi -e /path/to/pi-cc-shim`，`/model` 切到 anyrouter 的 Claude 模型，发一句 "Reply with exactly: pong"，`/cc-shim status` 看到 HTTP 200。
- **回归**：`scripts/probe-relay.sh` 按 `docs/relay-rules.md` 的变体表逐项删减，relay 规则变化时先跑它定位是哪一项变了。

## 5. 命名讨论

命名要同时满足：npm 可用、一眼看出是 pi 扩展、说清"干什么"、不宣称自己是 Anthropic 官方。

| 候选 | 优点 | 缺点 | npm |
| --- | --- | --- | --- |
| **pi-cc-shim** | 短；`shim` 准确表达"垫一层让它兼容" | `cc` 对新人不够直白，靠 description 补 | 可用（2026-09-19 复核仍未被占用） |
| pi-claude-code-shim | 搜索友好，pi.dev 上一眼懂 | 长；名字里带 "claude-code" 有被误认为官方的风险 | 可用 |
| pi-cc-fingerprint | 点明原理 | 听起来像检测工具而不是修复工具 | 可用 |
| pi-relay-shim | 通用，未来可扩展到别的 relay 规则 | 太泛，看不出和 Claude 有关 | 可用 |
| pi-cc-disguise / pi-cc-mask | 直白 | 语义偏负面，不利于上架 | 可用 |

**采用 `pi-cc-shim`**，理由：pi 生态的包普遍用 `pi-<功能>` 短名（如 `pi-tidy-footer`、`pi-minimal-toolcall`）；"shim" 是中性的工程词，准确且不惹争议；搜索可见性靠 `description` 和 `keywords` 里的 `claude-code`、`anyrouter` 补足。GitHub 仓库、npm 包、扩展文件名三者统一用这个名字。

README 首段已写清楚：这是第三方社区包，与 Anthropic、anyrouter 均无关联；只在你自己有权使用的 relay 账号上使用。

## 6. 分发与上架

### 6.1 阶段一：GitHub 直装（先做）

1. 建仓 `github.com/wylu1037/pi-cc-shim`，按 4.1 结构提交，打 tag `v0.1.0`。
2. 用户安装：

```bash
pi install git:github.com/wylu1037/pi-cc-shim@v0.1.0
# 或先试用不落盘
pi -e git:github.com/wylu1037/pi-cc-shim
```

3. 安装后在 `models.json` 里加 anyrouter 的 Claude provider（`api: "anthropic-messages"`，`baseUrl: "https://anyrouter.top"`，注意**不要**带 `/v1`），provider 名写进 `pi-cc-shim.json` 的 `providers`，或依赖默认的 `baseUrlPatterns` 自动匹配。

### 6.2 阶段二：npm 发布并进入 pi.dev/packages

pi.dev 的包画廊是**自动收录**的：抓取 npm 上带 `pi-package` keyword 的包，无需人工提交。所以只要：

1. `package.json` 的 `keywords` 含 `pi-package`（4.2 已包含）。
2. `npm publish --access public`（或 `pnpm publish --access public`）。
3. 可选：`pi.image` 放一张 `/cc-shim status` 的截图，画廊里有预览会更醒目。

发布后用户改用 `pi install npm:pi-cc-shim`。GitHub 安装方式继续保留，两者并存。

### 6.3 版本策略

relay 的校验规则是外部不可控因素。约定：规则变化只需改默认配置的，发 patch 版本；需要新增改写逻辑的，发 minor 版本；每次发版在 `docs/relay-rules.md` 的变更记录里补一行实测日期。

## 7. 风险与边界

- **规则漂移**：relay 随时可能加新校验项。缓解：所有规则可配置 + `/cc-shim dump` + 503/520 提醒 + `scripts/probe-relay.sh` 定位。
- **诱饵工具被调用**：已在 3.2 讨论，`message_end` 改写提示兜底；e2e 第 4 个场景覆盖。
- **提示词污染**：多了一句 "You are Claude Code" 可能让模型自称 Claude Code。实测对 pong 这类任务无影响；如果发现行为漂移，可在配置里把 `systemPrompt` 后面追加一句 "Ignore the previous sentence; you are running inside pi." 再观察，不过要先用探针脚本验证 relay 是否只做子串匹配。
- **钩子顺序**：`before_provider_request` 按扩展加载顺序执行，若用户还装了别的改 payload 的扩展，后加载者覆盖前者。README 里建议把本包放在 `settings.json` 的 packages 列表末尾。本包的规则都做了幂等处理（已有相同块 / 名字 / 值时不重复），同一请求被改写两次也不会坏。
- **beta 头**：用户若把 `anthropic-beta` 放进 `models.json` 的 `headers`，pi 会把它当作完整列表；本包只在其后追加，不覆盖。
- **合规**：本包只改写请求形态，不涉及绕过鉴权或计费；README 明确要求用户只对自己有权使用的 relay 账号使用。

## 8. 实现核对记录（2026-09-19，pi 0.85.1）

实现前逐项核对了 pi 的类型声明、文档与 dist 源码；以下事实与草案不同或草案未覆盖，实现以此为准。路径相对 `node_modules/@earendil-works/pi-coding-agent/`。

### 8.1 钩子签名（`dist/core/extensions/types.d.ts`）

- `BeforeProviderHeadersEvent { headers: ProviderHeaders }`，`ProviderHeaders = Record<string, string | null>`。
- `BeforeProviderRequestEvent { payload: unknown }`，返回值类型 `unknown`。
- `AfterProviderResponseEvent { status: number; headers: Record<string, string> }`。
- `ToolCallEvent { toolName, toolCallId, input }`，结果 `{ block?, reason?, terminate? }`。
- `MessageEndEvent { message: AgentMessage }`，结果 `{ message? }`，替换必须保持 `role`。
- `registerCommand(name, { description?, getArgumentCompletions?, handler(args: string, ctx: ExtensionCommandContext) })`。
- `ctx.sessionManager` 是 `ReadonlySessionManager`，包含 `getSessionId()`。

### 8.2 请求头的来源与去向（`pi-ai/dist/models.js` `applyAuth`，`dist/core/sdk.js` `streamFn`）

`applyAuth` 先把 provider 鉴权头与 `models.json` 里该 provider / model 的 `headers` 合并，再调 pi 的 `transformHeaders`（归因头 + `before_provider_headers`），结果作为 `options.headers` 进入 pi-ai 的 `createClient`，最终以 `defaultHeaders` 交给 Anthropic SDK。SDK 的 `buildHeaders` 顺序是 SDK 默认头 → 鉴权头 → `defaultHeaders` → 单次请求头，后者覆盖前者，所以我们设的 `User-Agent` 会盖过 SDK 与 pi 的 UA。合并用 `Object.assign`（区分大小写），故 3.1 要求置 `null` 清掉其它写法。

### 8.3 `after_provider_response` 只见成功（`pi-ai/dist/api/anthropic-messages.js` `stream`，SDK `client.js` `makeRequest`）

调用链是 `retryProviderRequest(() => client.beta.messages.create(params).asResponse())` → `options.onResponse(...)`。SDK 在 `!response.ok` 时抛 `APIError`，pi-ai 先按 429 / 5xx 重试（`utils/provider-retry.js`），用尽后在 `stream` 的 catch 里把 `error.message` 写进 `output.errorMessage`，`stopReason = "error"`。`APIError.makeMessage` 的格式是 `"<status> <body>"`，实测 e2e 拿到的 `errorMessage` 为 `520 {"error":{...}}`。因此拒绝识别放在 `message_end`：`role === "assistant" && stopReason === "error"`，用 `/^\s*(\d{3})(?=\s|$)/` 解析状态码。

### 8.4 `tool_call` 对未知工具不触发（`pi-agent-core/dist/agent-loop.js` `prepareToolCall`）

`prepareToolCall` 第一步 `currentContext.tools.find(t => t.name === toolCall.name)`，找不到直接返回 `kind: "immediate"` 的错误结果 `Tool <name> not found`，不会走到 `config.beforeToolCall`（即 `tool_call` 钩子）。该错误结果经 `emitToolResultMessage` 触发 `message_start` / `message_end`，`agent-session.js` 的 `_replaceMessageInPlace` 会把 `message_end` 返回的替换消息原地写回并持久化，所以 3.2 的改写在会话历史与下一轮上下文里都生效。API-key 鉴权下 pi 不做 Claude Code 工具名映射（`fromClaudeCodeName` 只在 OAuth 时启用），`Read` 会原样到达 agent loop。

### 8.5 beta 的合成路径（`anthropic-messages.js` `getBetaFeatures` / `buildParams`，SDK `resources/beta/messages/messages.js`）

`getBetaFeatures` 先扫 `model.headers` 与 `options.headers` 找 `anthropic-beta`：找到就把它按逗号拆成列表**直接返回**，跳过 interleaved-thinking、fine-grained-tool-streaming 等动态 beta；没找到才计算动态 beta。结果放进 `params.betas`，经 `onPayload`（`before_provider_request`）后交给 SDK，SDK 从 `params` 里取出 `betas` 并用 `betas.toString()` 设置 `anthropic-beta` 头（单次请求头，优先级最高）。因此在 payload 的 `betas` 上追加既保留 pi 的 beta，又保证头里一定有 `context-1m-2025-08-07`。

### 8.6 payload 形态（`anthropic-messages.js` `buildParams`）

`system` 是 `[{ type: "text", text, cache_control? }]`（无 system prompt 时缺失）；`tools[]` 最后一个带 `cache_control`；`metadata` 仅在上层传了 `user_id` 字符串时存在（pi-coding-agent 不传）；`betas` 非空时存在；`model` 为 `model.id`；`stream: true` 在钩子之后强制补回。pi 自身在 OAuth 模式下已经做了同类"stealth"：插开场句、`claude-cli/2.1.251` UA、`x-app: cli`、工具名映射为 Claude Code 大小写，本包相当于把这套行为搬到 API-key 场景。

### 8.7 扩展加载与运行时

- `pi -e <包目录>`：`resolveExtensionEntries` 读 `package.json` 的 `pi.extensions` → `./extensions` 目录 → 发现其中的 `cc-shim.ts`（e2e 第 3 个场景已验证）；`pi -e <文件>` 亦可。
- 扩展经 jiti 2.7 加载，TypeScript 无需编译；相对导入 `../src/x.ts` 可用。同一套源码用 Node 26 原生类型剥离跑单测，因此源码里不用 `enum` / 参数属性（`tsconfig` 的 `erasableSyntaxOnly` 保证）。
- `pi install` 走 `npm install --omit=dev`（pnpm 时禁用 peer 自动安装），本包无运行时依赖，`src/` 与 `extensions/` 一起进 `files`。
- `getAgentDir()` 尊重 `PI_CODING_AGENT_DIR`，e2e 借此使用临时 agent 目录，完全不碰用户的 `~/.pi`。
- `pi -p` 在没有 stdin 重定向时会等待终端输入；脚本里必须 `</dev/null`。

### 8.8 未做的事

- 没有对真实 anyrouter 账号发请求验证，只做了复刻规则的离线 e2e；上线前按 4.4 的"集成"步骤手动跑一次。
- 没有 git 提交；`v0.1.0` 打 tag 与 npm 发布按第 6 节执行。
