import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultConfig, loadConfig, mergeConfig, resolvePaths } from "../src/config.ts";

const enoent = () => {
	const error = new Error("ENOENT") as NodeJS.ErrnoException;
	error.code = "ENOENT";
	throw error;
};

describe("loadConfig", () => {
	test("文件不存在：默认值且无警告", () => {
		const loaded = loadConfig("/nope/pi-cc-shim.json", enoent);
		assert.equal(loaded.source, "defaults");
		assert.deepEqual(loaded.warnings, []);
		assert.deepEqual(loaded.config, defaultConfig());
	});

	test("读取失败（非 ENOENT）：默认值并警告", () => {
		const loaded = loadConfig("/x", () => {
			throw new Error("EACCES");
		});
		assert.equal(loaded.source, "defaults");
		assert.match(loaded.warnings[0] ?? "", /EACCES/);
	});

	test("JSON 语法错误：默认值并警告", () => {
		const loaded = loadConfig("/x", () => "{ nope");
		assert.equal(loaded.source, "defaults");
		assert.match(loaded.warnings[0] ?? "", /不是合法 JSON/);
	});

	test("合法文件：覆盖对应字段，其余保持默认", () => {
		const loaded = loadConfig("/x", () => JSON.stringify({ providers: ["a"], enabled: false }));
		assert.equal(loaded.source, "file");
		assert.deepEqual(loaded.config.providers, ["a"]);
		assert.equal(loaded.config.enabled, false);
		assert.deepEqual(loaded.config.baseUrlPatterns, ["anyrouter.top"]);
	});
});

describe("mergeConfig", () => {
	test("类型不符的字段保留默认值并警告", () => {
		const { config, warnings } = mergeConfig({ toolNames: "Read", betas: [1], headers: { a: 1 }, enabled: "yes" });
		assert.deepEqual(config.toolNames, defaultConfig().toolNames);
		assert.deepEqual(config.betas, defaultConfig().betas);
		assert.equal(config.enabled, true);
		assert.equal(warnings.length, 4);
	});

	test("未知字段给出警告但不影响其它字段", () => {
		const { config, warnings } = mergeConfig({ foo: 1, stripModelSuffix: false });
		assert.equal(config.stripModelSuffix, false);
		assert.deepEqual(warnings, ["未知字段 foo，已忽略"]);
	});

	test("顶层不是对象时全部使用默认值", () => {
		const { config, warnings } = mergeConfig([1, 2]);
		assert.deepEqual(config, defaultConfig());
		assert.equal(warnings.length, 1);
	});

	test("headers 里的 anthropic-beta 被剔除并提示改用 betas", () => {
		const { config, warnings } = mergeConfig({ headers: { "Anthropic-Beta": "x", "x-app": "cli" } });
		assert.deepEqual(config.headers, { "x-app": "cli" });
		assert.match(warnings[0] ?? "", /betas/);
	});

	test("默认值每次都是新副本", () => {
		const a = defaultConfig();
		a.toolNames.push("Zzz");
		assert.equal(defaultConfig().toolNames.includes("Zzz"), false);
	});
});

describe("resolvePaths", () => {
	test("配置与 dump 文件都落在 agent 目录下", () => {
		const paths = resolvePaths("/home/u/.pi/agent");
		assert.equal(paths.configFile, "/home/u/.pi/agent/pi-cc-shim.json");
		assert.equal(paths.dumpFile, "/home/u/.pi/agent/logs/cc-shim-last.json");
	});
});
