import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeMatch, TargetMatcher } from "../src/matcher.ts";
import type { ModelLike } from "../src/types.ts";

const model = (overrides: Partial<ModelLike> = {}): ModelLike => ({
	provider: "any.router.claude",
	api: "anthropic-messages",
	baseUrl: "https://anyrouter.top",
	id: "claude-fable-5-1",
	...overrides,
});

describe("TargetMatcher", () => {
	const matcher = new TargetMatcher({ providers: ["any.router.claude"], baseUrlPatterns: ["anyrouter.top"] });

	test("关闭时无论模型如何都不命中", () => {
		assert.deepEqual(matcher.evaluate(model(), false), { matched: false, reason: "disabled" });
	});

	test("未选模型不命中", () => {
		assert.equal(matcher.evaluate(undefined, true).reason, "no-model");
	});

	test("通道判断先于白名单：同名 provider 走 openai-responses 也不改写", () => {
		const result = matcher.evaluate(model({ api: "openai-responses" }), true);
		assert.equal(result.matched, false);
		assert.equal(result.reason, "api-mismatch");
		assert.equal(result.detail, "openai-responses");
	});

	test("providers 白名单精确匹配", () => {
		const result = matcher.evaluate(model({ baseUrl: "https://elsewhere.example" }), true);
		assert.deepEqual(result, { matched: true, reason: "provider", detail: "any.router.claude" });
	});

	test("baseUrl 子串兜底", () => {
		const result = matcher.evaluate(model({ provider: "my-name", baseUrl: "https://anyrouter.top/v1" }), true);
		assert.deepEqual(result, { matched: true, reason: "base-url", detail: "anyrouter.top" });
	});

	test("都不命中", () => {
		const result = matcher.evaluate(model({ provider: "anthropic", baseUrl: "https://api.anthropic.com" }), true);
		assert.deepEqual(result, { matched: false, reason: "unmatched" });
	});

	test("空 pattern 不会误匹配所有域名", () => {
		const loose = new TargetMatcher({ providers: [], baseUrlPatterns: [""] });
		assert.equal(loose.evaluate(model({ provider: "x" }), true).matched, false);
	});

	test("describeMatch 给出中文说明", () => {
		assert.match(describeMatch({ matched: true, reason: "base-url", detail: "anyrouter.top" }), /anyrouter\.top/);
		assert.match(describeMatch({ matched: false, reason: "api-mismatch", detail: "openai-responses" }), /openai-responses/);
	});
});
