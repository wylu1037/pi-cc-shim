# pi-cc-shim

🛂 Use Claude models in [pi](https://pi.dev) through relays that only accept Claude Code traffic, such as anyrouter.

Some relays fingerprint the Anthropic Messages payload and answer `503` / `520` to anything that does not look like Claude Code, regardless of load. pi-cc-shim reshapes each request in-process via pi's `before_provider_headers` / `before_provider_request` hooks. No proxy, no extra process, and it only fires for the providers you point it at.

> Third-party community package, not affiliated with Anthropic or anyrouter. It only changes the shape of requests and does not bypass authentication or billing. Use it with relay accounts you are entitled to.

## ✨ What it does

- 🪪 **Claude Code identity** — prepends the Claude Code opener to `system[]` and sets `metadata.user_id` in Claude Code's format (`device_id` stable per machine, `session_id` per session)
- 🧰 **Placeholder tools** — adds any missing `Agent` `Bash` `Edit` `Read` `Write` `Glob` `Grep` entries to `tools[]` as inert stubs whose descriptions point at pi's real tools
- 🏷️ **Model & betas** — strips the `[1m]` suffix from `model` and declares 1M context through the `context-1m-2025-08-07` beta instead
- 📡 **Headers** — sends `User-Agent: claude-cli/…` and `x-app: cli`; auth headers are never touched
- 🎯 **Scoped** — only `anthropic-messages` providers that match your config are rewritten; an `openai-responses` provider on the same host is left alone
- 🧠 **Self-healing tool calls** — if the model calls a stub tool, the "not found" error is rewritten into "use `read` instead" so it recovers on the next step
- 🧊 **Cache-friendly** — never adds `cache_control`; pi's own prompt-cache breakpoints stay intact

## 📦 Install

Requires pi ≥ 0.85.0 and Node ≥ 22.19.

```bash
pi install npm:pi-cc-shim

# or from GitHub
pi install git:github.com/wylu1037/pi-cc-shim

# or try it for a single run without installing
pi -e npm:pi-cc-shim
```

If other extensions also rewrite payloads, list pi-cc-shim last in `packages` in `settings.json`: `before_provider_request` hooks run in load order and the last one wins.

## ⚙️ Configure the provider

Add an `anthropic-messages` provider to `~/.pi/agent/models.json`. `baseUrl` must **not** end with `/v1`:

```json
{
  "providers": {
    "anyrouter": {
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

Any `baseUrl` containing `anyrouter.top` is matched out of the box; the provider key can be anything. Pick the model with `/model`. The footer shows `cc-shim ✓` while the shim is active.

## 🔧 Options

Optional `~/.pi/agent/pi-cc-shim.json`. Each relay check maps to one field, so you can follow rule changes without waiting for a release. Defaults:

```json
{
  "enabled": true,
  "providers": [],
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

| Field | Description |
| --- | --- |
| `enabled` | Master switch |
| `providers` | Exact provider keys from `models.json` to target; use it to narrow the scope |
| `baseUrlPatterns` | Fallback match: `baseUrl` contains any of these substrings |
| `systemPrompt` | Sentence inserted at `system[0]`; empty string disables it |
| `toolNames` | Tool names that must be present in `tools[]`; missing ones are stubbed |
| `headers` | Request headers to set; replaces the default object. Put `anthropic-beta` in `betas`, not here |
| `betas` | Appended to `payload.betas` |
| `stripModelSuffix` | Remove a trailing `[1m]` from `model` |
| `decoyToolHints` | Rewrite the error when the model calls a stub tool |

Fields of the wrong type fall back to their defaults and are reported at startup and in `/cc-shim status`.

## 🕹️ Commands

| Command | What it does |
| --- | --- |
| `/cc-shim` or `/cc-shim status` | Whether the current model matches and why, last response status, what was injected last |
| `/cc-shim on` / `/cc-shim off` | Toggle for this session only; the config file is not written |
| `/cc-shim dump` | Write the next request's final payload and headers (auth redacted) to `~/.pi/agent/logs/cc-shim-last.json` |

A warning pops up whenever the relay answers `503` / `520`.

## 🩺 Troubleshooting

1. `/cc-shim status`: confirm the model matches and the API is `anthropic-messages`.
2. Still rejected? `/cc-shim dump`, resend, then check `system[0]`, `tools`, `metadata.user_id`, `betas` and the headers in `cc-shim-last.json`.
3. Bisect the relay's rules with `RELAY_API_KEY=sk-... scripts/probe-relay.sh`. It sends a baseline request and then drops one rule at a time; fix the matching option.
4. If the extra "You are Claude Code" sentence makes the model drift, append something like `Ignore the previous sentence; you are running inside pi.` to `systemPrompt`.

The status code tells you which check failed (observed on anyrouter, 2026-09-18; relays change their rules without notice):

| Relay answers | What it checks | Option |
| --- | --- | --- |
| `503` | Claude Code opener in `system[]`, or the shape of `metadata.user_id` | `systemPrompt` (`user_id` is automatic) |
| `520` | At least 4 Claude Code tool names in `tools[]` | `toolNames` |
| `429` | `model` still carries a `[1M]` suffix | `stripModelSuffix` |
| `400` | `anthropic-beta` header lacks `context-1m-2025-08-07` | `betas` |

## 🛠️ Development

```bash
pnpm install
pnpm check   # tsc --noEmit + node --test
pnpm e2e     # fake relay + real pi process, fully offline
```

`scripts/fake-relay.mjs` mirrors the relay's checks. `scripts/e2e.sh` verifies rejection without the shim, success with it, stub-tool hint rewriting, and the RPC-mode commands and dump.

## License

MIT
