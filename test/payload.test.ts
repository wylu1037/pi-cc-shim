import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import {
	addedToolNames,
	betasRule,
	buildDecoyTool,
	createPayloadRewriter,
	decoyToolsRule,
	metadataRule,
	PayloadRewriter,
	stripModelSuffixRule,
	suggestAlternative,
	systemPromptRule,
} from "../src/payload.ts";
import type { AnthropicPayload, TextBlock, ToolDefinition } from "../src/types.ts";

const CC = "You are Claude Code, Anthropic's official CLI for Claude.";
const ctx = { deviceId: "d".repeat(64), sessionId: "sess-1" };
const tool = (name: string, extra: Record<string, unknown> = {}): ToolDefinition => ({
	name,
	description: `${name} tool`,
	input_schema: { type: "object", properties: { path: { type: "string" } } },
	...extra,
});

describe("stripModelSuffixRule", () => {
	test("去掉 [1M] 与 [1m] 后缀", () => {
		for (const suffix of ["[1M]", "[1m]"]) {
			const out = stripModelSuffixRule.apply({ model: `claude-fable-5-1${suffix}` }, ctx);
			assert.equal(out.payload.model, "claude-fable-5-1");
			assert.match(out.summary ?? "", /model:/);
		}
	});

	test("没有后缀时原样返回、无摘要", () => {
		const payload = { model: "claude-fable-5-1" };
		const out = stripModelSuffixRule.apply(payload, ctx);
		assert.equal(out.payload, payload);
		assert.equal(out.summary, undefined);
	});

	test("model 不是字符串时不动", () => {
		const payload = { model: 42 } as unknown as AnthropicPayload;
		assert.equal(stripModelSuffixRule.apply(payload, ctx).payload, payload);
	});
});

describe("systemPromptRule", () => {
	const rule = systemPromptRule(CC);

	test("system 为字符串：转成数组并前插", () => {
		const out = rule.apply({ system: "pi prompt" }, ctx);
		assert.deepEqual(out.payload.system, [
			{ type: "text", text: CC },
			{ type: "text", text: "pi prompt" },
		]);
	});

	test("system 为数组：前插且原块（含 cache_control）原样保留", () => {
		const original: TextBlock = { type: "text", text: "pi prompt", cache_control: { type: "ephemeral" } };
		const out = rule.apply({ system: [original] }, ctx);
		const system = out.payload.system as TextBlock[];
		assert.equal(system.length, 2);
		assert.deepEqual(system[0], { type: "text", text: CC });
		assert.equal(system[1], original);
		assert.equal("cache_control" in (system[0] ?? {}), false, "插入块不带 cache_control");
	});

	test("system 缺失或空串：新建数组", () => {
		assert.deepEqual(rule.apply({}, ctx).payload.system, [{ type: "text", text: CC }]);
		assert.deepEqual(rule.apply({ system: "" }, ctx).payload.system, [{ type: "text", text: CC }]);
	});

	test("已含相同块时幂等", () => {
		const payload = { system: [{ type: "text", text: CC } as TextBlock] };
		const out = rule.apply(payload, ctx);
		assert.equal(out.payload, payload);
		assert.equal(out.summary, undefined);
	});
});

describe("decoyToolsRule", () => {
	const names = ["Agent", "Bash", "Read"];
	const rule = decoyToolsRule(names);

	test("tools 缺失：新建数组并补齐全部", () => {
		const out = rule.apply({}, ctx);
		assert.deepEqual(out.payload.tools?.map((t) => t.name), names);
	});

	test("部分重叠：只补缺失项并追加在末尾", () => {
		const existing = [tool("read"), tool("Bash", { cache_control: { type: "ephemeral" } })];
		const out = rule.apply({ tools: existing }, ctx);
		assert.deepEqual(out.payload.tools?.map((t) => t.name), ["read", "Bash", "Agent", "Read"]);
		assert.equal(out.payload.tools?.[1], existing[1], "原有工具对象不被复制或改动");
	});

	test("已齐全：原样返回", () => {
		const payload = { tools: names.map((n) => tool(n)) };
		assert.equal(rule.apply(payload, ctx).payload, payload);
	});

	test("空壳工具的描述指向 pi 的真实工具", () => {
		const out = rule.apply({ tools: [tool("read"), tool("find")] }, ctx);
		const byName = new Map(out.payload.tools?.map((t) => [t.name, t]));
		assert.match(byName.get("Read")?.description ?? "", /`read` tool instead/);
		assert.match(byName.get("Agent")?.description ?? "", /Do not call it/);
		assert.deepEqual(byName.get("Read")?.input_schema, { type: "object", properties: {} });
	});
});

describe("suggestAlternative / buildDecoyTool", () => {
	test("优先小写同名，其次别名表", () => {
		assert.equal(suggestAlternative("Read", ["read", "bash"]), "read");
		assert.equal(suggestAlternative("Glob", ["read", "find"]), "find");
		assert.equal(suggestAlternative("Glob", ["read", "ls"]), "ls");
		assert.equal(suggestAlternative("Agent", ["read"]), undefined);
	});

	test("buildDecoyTool 产出合法的空 schema", () => {
		assert.deepEqual(buildDecoyTool("Glob", ["find"]), {
			name: "Glob",
			description: "Unavailable in this environment. Use the `find` tool instead.",
			input_schema: { type: "object", properties: {} },
		});
	});
});

describe("metadataRule", () => {
	test("已有 metadata 时只覆盖 user_id", () => {
		const out = metadataRule.apply({ metadata: { user_id: "old", other: 1 } }, ctx);
		assert.equal(out.payload.metadata?.other, 1);
		assert.deepEqual(JSON.parse(out.payload.metadata?.user_id as string), {
			device_id: ctx.deviceId,
			account_uuid: "",
			session_id: ctx.sessionId,
		});
	});

	test("metadata 缺失时新建", () => {
		const out = metadataRule.apply({}, ctx);
		assert.equal(typeof out.payload.metadata?.user_id, "string");
	});

	test("user_id 已是目标值时幂等", () => {
		const first = metadataRule.apply({}, ctx).payload;
		const second = metadataRule.apply(first, ctx);
		assert.equal(second.payload, first);
	});
});

describe("betasRule", () => {
	const rule = betasRule(["context-1m-2025-08-07"]);

	test("追加并去重，保留 pi 自己的 beta", () => {
		const out = rule.apply({ betas: ["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"] }, ctx);
		assert.deepEqual(out.payload.betas, ["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"]);
		assert.equal(out.summary, undefined);

		const added = rule.apply({ betas: ["fine-grained-tool-streaming-2025-05-14"] }, ctx);
		assert.deepEqual(added.payload.betas, ["fine-grained-tool-streaming-2025-05-14", "context-1m-2025-08-07"]);
	});

	test("betas 缺失时新建", () => {
		assert.deepEqual(rule.apply({}, ctx).payload.betas, ["context-1m-2025-08-07"]);
	});
});

describe("PayloadRewriter", () => {
	test("按默认配置装配的规则链一次完成全部改写，且不修改原对象", () => {
		const original: AnthropicPayload = {
			model: "claude-fable-5-1[1M]",
			system: [{ type: "text", text: "pi prompt", cache_control: { type: "ephemeral" } }],
			tools: [tool("read"), tool("bash")],
			messages: [{ role: "user", content: "hi" }],
			betas: ["interleaved-thinking-2025-05-14"],
			max_tokens: 100,
		};
		const snapshot = structuredClone(original);

		const rewriter = createPayloadRewriter(defaultConfig());
		const { payload, summaries } = rewriter.rewrite(original, ctx);

		assert.deepEqual(original, snapshot, "入参不能被修改");
		assert.equal(payload.model, "claude-fable-5-1");
		assert.equal((payload.system as TextBlock[])[0]?.text, CC);
		assert.deepEqual(
			payload.tools?.map((t) => t.name),
			["read", "bash", "Agent", "Bash", "Edit", "Read", "Write", "Glob", "Grep"],
		);
		assert.deepEqual(payload.betas, ["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"]);
		assert.equal(typeof payload.metadata?.user_id, "string");
		assert.equal(payload.messages, original.messages, "无关字段透传");
		assert.equal(payload.max_tokens, 100);
		assert.equal(summaries.length, 5);
		assert.deepEqual(rewriter.ruleNames, ["model", "system", "tools", "metadata", "betas"]);
	});

	test("关闭对应开关后规则不进链", () => {
		const config = { ...defaultConfig(), stripModelSuffix: false, toolNames: [], betas: [], systemPrompt: "" };
		const rewriter = createPayloadRewriter(config);
		assert.deepEqual(rewriter.ruleNames, ["metadata"]);
		const { payload } = rewriter.rewrite({ model: "x[1m]" }, ctx);
		assert.equal(payload.model, "x[1m]");
		assert.equal(payload.tools, undefined);
	});

	test("空规则链原样返回", () => {
		const payload = { model: "m" };
		const out = new PayloadRewriter([]).rewrite(payload, ctx);
		assert.equal(out.payload, payload);
		assert.deepEqual(out.summaries, []);
	});
});

describe("addedToolNames", () => {
	test("只返回改写后新增的名字", () => {
		const before = { tools: [tool("read")] };
		const after = { tools: [tool("read"), tool("Read"), tool("Glob")] };
		assert.deepEqual(addedToolNames(before, after), ["Read", "Glob"]);
		assert.deepEqual(addedToolNames({}, {}), []);
	});
});
