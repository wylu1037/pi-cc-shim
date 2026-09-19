import type { ShimConfig } from "./config.ts";
import { buildUserId } from "./identity.ts";
import { isRecord, type AnthropicPayload, type TextBlock, type ToolDefinition } from "./types.ts";

/**
 * Payload rewriting: each relay check maps to one PayloadRule, chained in order by PayloadRewriter (chain of responsibility).
 * Rules are pure functions: they never mutate the input and always return a new object, which keeps them unit-testable and avoids polluting the payload other extensions see.
 */

export interface RewriteContext {
	deviceId: string;
	sessionId: string;
}

export interface RuleResult {
	payload: AnthropicPayload;
	/** What this rule actually did; omitted when nothing changed */
	summary?: string;
}

export interface PayloadRule {
	readonly name: string;
	apply(payload: AnthropicPayload, ctx: RewriteContext): RuleResult;
}

// ---------------------------------------------------------------------------
// model: strip the [1m] suffix; 1M context is declared via betas instead
// ---------------------------------------------------------------------------

const MODEL_SUFFIX = /\[1m\]$/i;

export const stripModelSuffixRule: PayloadRule = {
	name: "model",
	apply(payload) {
		const model = payload.model;
		if (typeof model !== "string" || !MODEL_SUFFIX.test(model)) return { payload };
		const next = model.replace(MODEL_SUFFIX, "");
		return { payload: { ...payload, model: next }, summary: `model: ${model} → ${next}` };
	},
};

// ---------------------------------------------------------------------------
// system: prepend the opener without cache_control so pi's existing cache breakpoints stay intact
// ---------------------------------------------------------------------------

function normalizeSystem(system: unknown): TextBlock[] {
	if (typeof system === "string") return system.length > 0 ? [{ type: "text", text: system }] : [];
	if (Array.isArray(system)) return system as TextBlock[];
	return [];
}

export function systemPromptRule(text: string): PayloadRule {
	return {
		name: "system",
		apply(payload) {
			const existing = normalizeSystem(payload.system);
			// Skip if an identical block already exists (e.g. inserted by pi itself in OAuth mode), keeping this idempotent
			if (existing.some((block) => block.type === "text" && block.text === text)) return { payload };
			const block: TextBlock = { type: "text", text };
			return {
				payload: { ...payload, system: [block, ...existing] },
				summary: `system: prepended Claude Code opener (${existing.length} existing kept)`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// tools: add missing Claude Code tool names as stubs whose descriptions point at pi's real tools
// ---------------------------------------------------------------------------

/** Claude Code tool name → candidate pi built-in tools (by priority); unlisted names fall back to the lowercase equivalent */
const ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
	Glob: ["find", "ls"],
	Grep: ["grep"],
	Agent: [],
	Task: [],
};

export function suggestAlternative(decoyName: string, available: readonly string[]): string | undefined {
	const candidates = [decoyName.toLowerCase(), ...(ALTERNATIVES[decoyName] ?? [])];
	return candidates.find((candidate) => available.includes(candidate));
}

export function buildDecoyTool(name: string, available: readonly string[]): ToolDefinition {
	const alternative = suggestAlternative(name, available);
	const hint = alternative ? ` Use the \`${alternative}\` tool instead.` : " Do not call it.";
	return {
		name,
		description: `Unavailable in this environment.${hint}`,
		input_schema: { type: "object", properties: {} },
	};
}

export function toolNames(payload: AnthropicPayload): string[] {
	return Array.isArray(payload.tools) ? payload.tools.map((tool) => tool.name) : [];
}

/** Diff before/after to find the tool names this extension appended, so the response side can detect stray model calls */
export function addedToolNames(before: AnthropicPayload, after: AnthropicPayload): string[] {
	const had = new Set(toolNames(before));
	return toolNames(after).filter((name) => !had.has(name));
}

export function decoyToolsRule(names: readonly string[]): PayloadRule {
	return {
		name: "tools",
		apply(payload) {
			const existing = Array.isArray(payload.tools) ? payload.tools : [];
			const present = new Set(existing.map((tool) => tool.name));
			const missing = names.filter((name) => !present.has(name));
			if (missing.length === 0) return { payload };
			const realNames = existing.map((tool) => tool.name);
			const decoys = missing.map((name) => buildDecoyTool(name, realNames));
			return {
				// Append at the end: pi puts cache_control on its own last tool, so prepending would break the cache prefix
				payload: { ...payload, tools: [...existing, ...decoys] },
				summary: `tools: appended stubs ${missing.join(", ")} (${existing.length} existing kept)`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// metadata.user_id: JSON string in Claude Code format; only this key is overwritten when metadata already exists
// ---------------------------------------------------------------------------

export const metadataRule: PayloadRule = {
	name: "metadata",
	apply(payload, ctx) {
		const metadata = isRecord(payload.metadata) ? payload.metadata : {};
		const userId = buildUserId(ctx.deviceId, ctx.sessionId);
		if (metadata.user_id === userId) return { payload };
		return {
			payload: { ...payload, metadata: { ...metadata, user_id: userId } },
			summary: `metadata.user_id: set to Claude Code format (session ${ctx.sessionId})`,
		};
	},
};

// ---------------------------------------------------------------------------
// betas: appended after the betas pi computed itself; the SDK turns them into the anthropic-beta header
// ---------------------------------------------------------------------------

export function betasRule(betas: readonly string[]): PayloadRule {
	return {
		name: "betas",
		apply(payload) {
			const existing = Array.isArray(payload.betas)
				? payload.betas.filter((item): item is string => typeof item === "string")
				: [];
			const missing = betas.filter((beta) => !existing.includes(beta));
			if (missing.length === 0) return { payload };
			return {
				payload: { ...payload, betas: [...existing, ...missing] },
				summary: `betas: appended ${missing.join(", ")}`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Chain of responsibility
// ---------------------------------------------------------------------------

export interface RewriteOutcome {
	payload: AnthropicPayload;
	summaries: string[];
}

export class PayloadRewriter {
	readonly #rules: readonly PayloadRule[];

	constructor(rules: readonly PayloadRule[]) {
		this.#rules = rules;
	}

	get ruleNames(): string[] {
		return this.#rules.map((rule) => rule.name);
	}

	rewrite(payload: AnthropicPayload, ctx: RewriteContext): RewriteOutcome {
		const summaries: string[] = [];
		let current = payload;
		for (const rule of this.#rules) {
			const result = rule.apply(current, ctx);
			current = result.payload;
			if (result.summary) summaries.push(result.summary);
		}
		return { payload: current, summaries };
	}
}

/** Assemble the rule chain from config; disabled rules are left out so no flags are re-checked at runtime */
export function createPayloadRewriter(config: ShimConfig): PayloadRewriter {
	const rules: PayloadRule[] = [];
	if (config.stripModelSuffix) rules.push(stripModelSuffixRule);
	if (config.systemPrompt.length > 0) rules.push(systemPromptRule(config.systemPrompt));
	if (config.toolNames.length > 0) rules.push(decoyToolsRule(config.toolNames));
	rules.push(metadataRule);
	if (config.betas.length > 0) rules.push(betasRule(config.betas));
	return new PayloadRewriter(rules);
}
