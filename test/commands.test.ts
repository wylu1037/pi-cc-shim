import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createShimCommand, formatStatus, type CommandDeps } from "../src/commands.ts";
import { defaultConfig, resolvePaths } from "../src/config.ts";
import { DumpRecorder } from "../src/dump.ts";
import { TargetMatcher } from "../src/matcher.ts";
import { createSessionState } from "../src/state.ts";
import type { ModelLike } from "../src/types.ts";

function makeDeps(): CommandDeps {
	const config = defaultConfig();
	return {
		state: createSessionState(true),
		loaded: { config, warnings: [], source: "defaults" },
		paths: resolvePaths("/agent"),
		matcher: new TargetMatcher(config),
		dump: new DumpRecorder("/agent/logs/cc-shim-last.json", () => {}),
		refresh: () => {},
	};
}

const model: ModelLike = { provider: "any.router.claude", api: "anthropic-messages", baseUrl: "https://anyrouter.top", id: "claude-fable-5-1" };

describe("formatStatus", () => {
	test("命中时展示生效原因、模型与注入摘要", () => {
		const deps = makeDeps();
		deps.state.lastStatus = { code: 200, at: "t1", source: "response", model: "claude-fable-5-1" };
		deps.state.lastInjection = { at: "t0", model: "claude-fable-5-1", summaries: ["model: a → b"] };
		const text = formatStatus(deps, model);
		assert.match(text, /🟢 active: baseUrl contains "anyrouter.top"/);
		assert.match(text, /any\.router\.claude \/ claude-fable-5-1/);
		assert.match(text, /HTTP 200/);
		assert.match(text, /- model: a → b/);
		assert.match(text, /built-in defaults/);
	});

	test("关闭、无请求、dump 就绪的展示", () => {
		const deps = makeDeps();
		deps.state.enabled = false;
		deps.dump.arm();
		const text = formatStatus(deps, undefined);
		assert.match(text, /⚪ inactive: disabled via \/cc-shim off/);
		assert.match(text, /no requests yet/);
		assert.match(text, /📝 Dump: armed/);
	});
});

describe("createShimCommand", () => {
	function fakeCtx(model: ModelLike | undefined) {
		const notices: string[] = [];
		const ctx = { model, ui: { notify: (message: string) => notices.push(message) } };
		return { ctx: ctx as unknown as Parameters<ReturnType<typeof createShimCommand>["handler"]>[1], notices };
	}

	test("无参数等价于 status；on/off 切换会话态并触发刷新", async () => {
		const deps = makeDeps();
		let refreshed = 0;
		deps.refresh = () => refreshed++;
		const command = createShimCommand(deps);
		const { ctx, notices } = fakeCtx(model);

		await command.handler("", ctx);
		assert.match(notices[0] ?? "", /🟢 active/);

		await command.handler("off", ctx);
		assert.equal(deps.state.enabled, false);
		await command.handler("on", ctx);
		assert.equal(deps.state.enabled, true);
		assert.equal(refreshed, 2);
	});

	test("dump 武装记录器；未知子命令报错", async () => {
		const deps = makeDeps();
		const command = createShimCommand(deps);
		const { ctx, notices } = fakeCtx(model);
		await command.handler("dump", ctx);
		assert.equal(deps.dump.armed, true);
		await command.handler("bogus", ctx);
		assert.match(notices.at(-1) ?? "", /unknown subcommand "bogus"/);
	});

	test("参数补全按前缀过滤", () => {
		const command = createShimCommand(makeDeps());
		assert.deepEqual(command.getArgumentCompletions("d"), [{ value: "dump", label: "dump" }]);
		assert.equal(command.getArgumentCompletions("zz"), null);
	});
});
