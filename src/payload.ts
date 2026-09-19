import type { ShimConfig } from "./config.ts";
import { buildUserId } from "./identity.ts";
import { isRecord, type AnthropicPayload, type TextBlock, type ToolDefinition } from "./types.ts";

/**
 * 请求体改写：每条 relay 校验规则对应一个 PayloadRule，PayloadRewriter 按顺序串起来（责任链）。
 * 规则都是纯函数：不修改入参，只返回新对象；便于单测，也避免污染其它扩展看到的 payload。
 */

export interface RewriteContext {
	deviceId: string;
	sessionId: string;
}

export interface RuleResult {
	payload: AnthropicPayload;
	/** 本条规则实际做了什么；没做任何改动时省略 */
	summary?: string;
}

export interface PayloadRule {
	readonly name: string;
	apply(payload: AnthropicPayload, ctx: RewriteContext): RuleResult;
}

// ---------------------------------------------------------------------------
// model：去掉 [1m] 后缀，1M 上下文改由 betas 声明
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
// system：头部插入开场句，不带 cache_control，pi 原有的缓存断点原样保留
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
			// 已经有完全相同的块（例如 OAuth 模式下 pi 自己插的）就不重复插，保持幂等
			if (existing.some((block) => block.type === "text" && block.text === text)) return { payload };
			const block: TextBlock = { type: "text", text };
			return {
				payload: { ...payload, system: [block, ...existing] },
				summary: `system: 头部插入 Claude Code 开场句（原有 ${existing.length} 块保留）`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// tools：补齐缺失的 Claude Code 工具名（空壳），描述里指向 pi 的真实工具
// ---------------------------------------------------------------------------

/** Claude Code 工具名 → pi 内置工具候选（按优先级）；没列出的默认尝试小写同名 */
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

/** 前后对比得出本扩展追加的工具名，供响应侧识别模型误调 */
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
				// 追加在末尾：pi 把 cache_control 放在自己最后一个工具上，前插会打乱缓存前缀
				payload: { ...payload, tools: [...existing, ...decoys] },
				summary: `tools: 追加空壳 ${missing.join(", ")}（原有 ${existing.length} 个保留）`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// metadata.user_id：Claude Code 格式的 JSON 串；已有 metadata 时只覆盖这一个键
// ---------------------------------------------------------------------------

export const metadataRule: PayloadRule = {
	name: "metadata",
	apply(payload, ctx) {
		const metadata = isRecord(payload.metadata) ? payload.metadata : {};
		const userId = buildUserId(ctx.deviceId, ctx.sessionId);
		if (metadata.user_id === userId) return { payload };
		return {
			payload: { ...payload, metadata: { ...metadata, user_id: userId } },
			summary: `metadata.user_id: 设为 Claude Code 格式（session ${ctx.sessionId}）`,
		};
	},
};

// ---------------------------------------------------------------------------
// betas：追加到 pi 自己算出的 beta 列表之后，SDK 会合成 anthropic-beta 头
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
				summary: `betas: 追加 ${missing.join(", ")}`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// 责任链
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

/** 按配置装配规则链；关掉的规则不进链，避免运行时反复判断开关 */
export function createPayloadRewriter(config: ShimConfig): PayloadRewriter {
	const rules: PayloadRule[] = [];
	if (config.stripModelSuffix) rules.push(stripModelSuffixRule);
	if (config.systemPrompt.length > 0) rules.push(systemPromptRule(config.systemPrompt));
	if (config.toolNames.length > 0) rules.push(decoyToolsRule(config.toolNames));
	rules.push(metadataRule);
	if (config.betas.length > 0) rules.push(betasRule(config.betas));
	return new PayloadRewriter(rules);
}
