import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildDecoyHint, extractHttpStatus, isRelayRejection, rejectionAdvice } from "../src/safeguards.ts";

describe("extractHttpStatus", () => {
	test("解析 SDK 风格的错误文本", () => {
		assert.equal(extractHttpStatus("503 Service Unavailable"), 503);
		assert.equal(extractHttpStatus("520 status code (no body)"), 520);
		assert.equal(extractHttpStatus('400 {"error":{"message":"请启用 1m 上下文后重试"}}'), 400);
		assert.equal(extractHttpStatus("  429 rate limited"), 429);
	});

	test("非状态码开头或空文本返回 undefined", () => {
		assert.equal(extractHttpStatus("Request was aborted"), undefined);
		assert.equal(extractHttpStatus("2025 is not a status"), undefined);
		assert.equal(extractHttpStatus("503x"), undefined);
		assert.equal(extractHttpStatus(undefined), undefined);
	});
});

describe("isRelayRejection", () => {
	test("只把 503/520 视为指纹拒绝", () => {
		assert.equal(isRelayRejection(503), true);
		assert.equal(isRelayRejection(520), true);
		assert.equal(isRelayRejection(429), false);
		assert.equal(isRelayRejection(undefined), false);
	});
});

describe("buildDecoyHint / rejectionAdvice", () => {
	test("提示指向可用的真实工具", () => {
		assert.match(buildDecoyHint("Read", ["read", "bash"]), /Call `read` instead/);
		assert.match(buildDecoyHint("Glob", ["find"]), /Call `find` instead/);
		assert.match(buildDecoyHint("Agent", ["read"]), /Do not call it again/);
	});

	test("拒绝提示包含状态码与排查入口", () => {
		const advice = rejectionAdvice(503);
		assert.match(advice, /503/);
		assert.match(advice, /\/cc-shim dump/);
	});
});
