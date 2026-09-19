import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./types.ts";

/**
 * 用户配置 ~/.pi/agent/pi-cc-shim.json。
 * relay 的每条校验规则都对应一个可改的字段，规则漂移时改 JSON 即可，不必等发版。
 */
export interface ShimConfig {
	/** 总开关；/cc-shim on|off 只改会话态，不写回文件 */
	enabled: boolean;
	/** models.json 里 providers 的键名白名单，与 ctx.model.provider 精确匹配 */
	providers: string[];
	/** 兜底规则：ctx.model.baseUrl 包含任一子串即命中 */
	baseUrlPatterns: string[];
	/** 插到 system[0] 的 Claude Code 开场句 */
	systemPrompt: string;
	/** 必须出现在 tools[] 里的 Claude Code 工具名，缺的补空壳 */
	toolNames: string[];
	/** 逐个覆盖的请求头。不要放 anthropic-beta，请改用 betas */
	headers: Record<string, string>;
	/** 追加到 payload.betas；SDK 会把它转成 anthropic-beta 头 */
	betas: string[];
	/** 去掉 model 末尾的 [1m] / [1M] 后缀 */
	stripModelSuffix: boolean;
	/** 模型误调诱饵工具时，把 "not found" 改写成指向真实工具的提示 */
	decoyToolHints: boolean;
}

const DEFAULTS: ShimConfig = {
	enabled: true,
	providers: [],
	baseUrlPatterns: ["anyrouter.top"],
	systemPrompt: "You are Claude Code, Anthropic's official CLI for Claude.",
	toolNames: ["Agent", "Bash", "Edit", "Read", "Write", "Glob", "Grep"],
	headers: {
		"User-Agent": "claude-cli/2.1.274 (external, cli)",
		"x-app": "cli",
	},
	betas: ["context-1m-2025-08-07"],
	stripModelSuffix: true,
	decoyToolHints: true,
};

/** 每次返回新副本，避免调用方误改共享默认值 */
export function defaultConfig(): ShimConfig {
	return structuredClone(DEFAULTS);
}

export const CONFIG_FILE_NAME = "pi-cc-shim.json";

export interface ShimPaths {
	agentDir: string;
	configFile: string;
	dumpFile: string;
}

export function resolvePaths(agentDir: string): ShimPaths {
	return {
		agentDir,
		configFile: join(agentDir, CONFIG_FILE_NAME),
		dumpFile: join(agentDir, "logs", "cc-shim-last.json"),
	};
}

// ---------------------------------------------------------------------------
// 校验：表驱动，新增字段只需在 FIELD_KINDS 里登记一行
// ---------------------------------------------------------------------------

type FieldKind = "boolean" | "string" | "string[]" | "headers";

const FIELD_KINDS: Record<keyof ShimConfig, FieldKind> = {
	enabled: "boolean",
	providers: "string[]",
	baseUrlPatterns: "string[]",
	systemPrompt: "string",
	toolNames: "string[]",
	headers: "headers",
	betas: "string[]",
	stripModelSuffix: "boolean",
	decoyToolHints: "boolean",
};

const KIND_TEXT: Record<FieldKind, string> = {
	boolean: "布尔值",
	string: "字符串",
	"string[]": "字符串数组",
	headers: "字符串到字符串的对象",
};

function accepts(kind: FieldKind, value: unknown): boolean {
	switch (kind) {
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "string[]":
			return Array.isArray(value) && value.every((item) => typeof item === "string");
		case "headers":
			return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
	}
}

export interface MergeResult {
	config: ShimConfig;
	warnings: string[];
}

/** 把用户 JSON 合并到默认值上；类型不符的字段保留默认值并给出警告，绝不因配置错误让扩展失效 */
export function mergeConfig(raw: unknown): MergeResult {
	const config = defaultConfig();
	const warnings: string[] = [];
	if (!isRecord(raw)) {
		warnings.push("配置文件顶层不是 JSON 对象，已全部使用默认值");
		return { config, warnings };
	}

	const target = config as unknown as Record<string, unknown>;
	for (const [key, kind] of Object.entries(FIELD_KINDS) as [keyof ShimConfig, FieldKind][]) {
		if (!(key in raw)) continue;
		const value = raw[key];
		if (!accepts(kind, value)) {
			warnings.push(`字段 ${key} 应为${KIND_TEXT[kind]}，已使用默认值`);
			continue;
		}
		target[key] = value;
	}
	for (const key of Object.keys(raw)) {
		if (!(key in FIELD_KINDS)) warnings.push(`未知字段 ${key}，已忽略`);
	}

	// pi-ai 一旦在请求头里看到 anthropic-beta，就把它当作完整 beta 列表并放弃自己动态计算的 beta，
	// 所以这个头只能通过 betas 字段走 payload 追加。
	const betaHeader = Object.keys(config.headers).find((name) => name.toLowerCase() === "anthropic-beta");
	if (betaHeader !== undefined) {
		delete config.headers[betaHeader];
		warnings.push(`headers 里的 ${betaHeader} 已忽略，请改用 betas 字段`);
	}
	return { config, warnings };
}

export interface LoadedConfig extends MergeResult {
	source: "file" | "defaults";
}

export type FileReader = (path: string) => string;

const readUtf8: FileReader = (path) => readFileSync(path, "utf8");

/** 文件不存在时静默使用默认值；其它错误（权限、JSON 语法）记为警告 */
export function loadConfig(filePath: string, read: FileReader = readUtf8): LoadedConfig {
	let text: string;
	try {
		text = read(filePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const warnings = code === "ENOENT" ? [] : [`读取 ${filePath} 失败：${String(error)}`];
		return { config: defaultConfig(), warnings, source: "defaults" };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			config: defaultConfig(),
			warnings: [`${filePath} 不是合法 JSON：${(error as Error).message}`],
			source: "defaults",
		};
	}
	return { ...mergeConfig(raw), source: "file" };
}
