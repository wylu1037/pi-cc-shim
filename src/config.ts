import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./types.ts";

/**
 * User config at ~/.pi/agent/pi-cc-shim.json.
 * Every relay check maps to an editable field, so rule drift can be fixed by editing JSON without waiting for a release.
 */
export interface ShimConfig {
	/** Master switch; /cc-shim on|off only changes session state and never writes back to the file */
	enabled: boolean;
	/** Allowlist of provider keys from models.json, matched exactly against ctx.model.provider */
	providers: string[];
	/** Fallback rule: matches when ctx.model.baseUrl contains any of these substrings */
	baseUrlPatterns: string[];
	/** Claude Code opener inserted at system[0] */
	systemPrompt: string;
	/** Claude Code tool names that must be present in tools[]; missing ones get stubs */
	toolNames: string[];
	/** Request headers overridden one by one. Do not put anthropic-beta here; use betas instead */
	headers: Record<string, string>;
	/** Appended to payload.betas; the SDK turns it into the anthropic-beta header */
	betas: string[];
	/** Strip a trailing [1m] / [1M] suffix from model */
	stripModelSuffix: boolean;
	/** When the model calls a decoy tool, rewrite "not found" into a hint pointing at the real tool */
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

/** Returns a fresh copy each time so callers cannot accidentally mutate the shared defaults */
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
// Validation: table-driven; a new field only needs one entry in FIELD_KINDS
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
	boolean: "a boolean",
	string: "a string",
	"string[]": "an array of strings",
	headers: "an object of string values",
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

/** Merge user JSON onto the defaults; mistyped fields keep their default and produce a warning, so a bad config never disables the extension */
export function mergeConfig(raw: unknown): MergeResult {
	const config = defaultConfig();
	const warnings: string[] = [];
	if (!isRecord(raw)) {
		warnings.push("config root is not a JSON object, using all defaults");
		return { config, warnings };
	}

	const target = config as unknown as Record<string, unknown>;
	for (const [key, kind] of Object.entries(FIELD_KINDS) as [keyof ShimConfig, FieldKind][]) {
		if (!(key in raw)) continue;
		const value = raw[key];
		if (!accepts(kind, value)) {
			warnings.push(`field ${key} must be ${KIND_TEXT[kind]}, using default`);
			continue;
		}
		target[key] = value;
	}
	for (const key of Object.keys(raw)) {
		if (!(key in FIELD_KINDS)) warnings.push(`unknown field ${key} ignored`);
	}

	// Once pi-ai sees anthropic-beta in the request headers it treats it as the full beta list and drops its own computed betas,
	// so this header may only be added through the betas field on the payload.
	const betaHeader = Object.keys(config.headers).find((name) => name.toLowerCase() === "anthropic-beta");
	if (betaHeader !== undefined) {
		delete config.headers[betaHeader];
		warnings.push(`${betaHeader} in headers ignored, use the betas field instead`);
	}
	return { config, warnings };
}

export interface LoadedConfig extends MergeResult {
	source: "file" | "defaults";
}

export type FileReader = (path: string) => string;

const readUtf8: FileReader = (path) => readFileSync(path, "utf8");

/** Silently use defaults when the file is missing; other errors (permissions, JSON syntax) become warnings */
export function loadConfig(filePath: string, read: FileReader = readUtf8): LoadedConfig {
	let text: string;
	try {
		text = read(filePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const warnings = code === "ENOENT" ? [] : [`failed to read ${filePath}: ${String(error)}`];
		return { config: defaultConfig(), warnings, source: "defaults" };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			config: defaultConfig(),
			warnings: [`${filePath} is not valid JSON: ${(error as Error).message}`],
			source: "defaults",
		};
	}
	return { ...mergeConfig(raw), source: "file" };
}
