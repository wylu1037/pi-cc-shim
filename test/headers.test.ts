import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getHeader, HeaderRewriter, setHeader } from "../src/headers.ts";
import type { ProviderHeaders } from "../src/types.ts";

describe("setHeader", () => {
	test("新增与同名覆盖", () => {
		const headers: ProviderHeaders = { "x-app": "old" };
		setHeader(headers, "x-app", "cli");
		setHeader(headers, "User-Agent", "ua");
		assert.deepEqual(headers, { "x-app": "cli", "User-Agent": "ua" });
	});

	test("大小写不同的旧键置 null（pi 约定 null = 删除）而不是残留", () => {
		const headers: ProviderHeaders = { "user-agent": "codex-tui/0.1", "USER-AGENT": "x" };
		setHeader(headers, "User-Agent", "claude-cli/2.1.274 (external, cli)");
		assert.deepEqual(headers, {
			"user-agent": null,
			"USER-AGENT": null,
			"User-Agent": "claude-cli/2.1.274 (external, cli)",
		});
	});

	test("getHeader 大小写不敏感且跳过 null", () => {
		assert.equal(getHeader({ "user-agent": null, "User-Agent": "ua" }, "USER-agent"), "ua");
		assert.equal(getHeader({}, "x"), undefined);
	});
});

describe("HeaderRewriter", () => {
	const rewriter = new HeaderRewriter({ "User-Agent": "ua", "x-app": "cli" });

	test("原地改写并返回摘要", () => {
		const headers: ProviderHeaders = { "user-agent": "pi/0.85", "x-app": "cli", "x-api-key": "k" };
		const summaries = rewriter.apply(headers);
		assert.equal(headers["User-Agent"], "ua");
		assert.equal(headers["user-agent"], null);
		assert.equal(headers["x-api-key"], "k", "不动鉴权头");
		assert.deepEqual(summaries, ['User-Agent: "pi/0.85" → "ua"', 'x-app: already "cli"']);
	});

	test("空对象也能写入", () => {
		const headers: ProviderHeaders = {};
		const summaries = rewriter.apply(headers);
		assert.deepEqual(headers, { "User-Agent": "ua", "x-app": "cli" });
		assert.deepEqual(summaries, ['User-Agent: set to "ua"', 'x-app: set to "cli"']);
	});
});
