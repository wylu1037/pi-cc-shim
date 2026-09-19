import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DumpRecorder, redactHeaders } from "../src/dump.ts";

describe("redactHeaders", () => {
	test("鉴权头脱敏，其它原样，null 保留", () => {
		assert.deepEqual(
			redactHeaders({ Authorization: "Bearer k", "x-api-key": "k", "User-Agent": "ua", "user-agent": null }),
			{ Authorization: "<redacted>", "x-api-key": "<redacted>", "User-Agent": "ua", "user-agent": null },
		);
	});
});

describe("DumpRecorder", () => {
	test("未武装时不写文件", () => {
		const writes: string[] = [];
		const recorder = new DumpRecorder("/tmp/x.json", (path) => writes.push(path));
		recorder.captureHeaders({ a: "1" });
		assert.equal(recorder.captureRequest({ applied: true, matchReason: "r", summaries: [], payload: {} }), undefined);
		assert.deepEqual(writes, []);
	});

	test("武装后：合并请求头与 payload 落盘一次，随后自动解除", () => {
		let written: { path: string; content: string } | undefined;
		const recorder = new DumpRecorder("/tmp/x.json", (path, content) => (written = { path, content }));
		recorder.arm();
		assert.equal(recorder.armed, true);
		recorder.captureHeaders({ "x-api-key": "secret", "x-app": "cli" });
		const path = recorder.captureRequest({
			model: { provider: "p", api: "anthropic-messages", baseUrl: "u", id: "m" },
			applied: true,
			matchReason: "reason",
			summaries: ["s"],
			payload: { model: "m" },
		});
		assert.equal(path, "/tmp/x.json");
		assert.equal(recorder.armed, false);
		const snapshot = JSON.parse(written?.content ?? "{}");
		assert.equal(snapshot.headers["x-api-key"], "<redacted>");
		assert.equal(snapshot.headers["x-app"], "cli");
		assert.deepEqual(snapshot.payload, { model: "m" });
		assert.equal(snapshot.applied, true);
		assert.ok(typeof snapshot.capturedAt === "string");

		assert.equal(recorder.captureRequest({ applied: true, matchReason: "r", summaries: [], payload: {} }), undefined);
	});
});
