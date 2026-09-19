import type { ShimConfig } from "./config.ts";
import type { ModelLike } from "./types.ts";

export const ANTHROPIC_MESSAGES_API = "anthropic-messages";

export type MatchReason =
	/** 会话内已通过 /cc-shim off 关闭 */
	| "disabled"
	/** 尚未选择模型 */
	| "no-model"
	/** 不是 anthropic-messages 通道（例如同一域名下走 codex 的 openai-responses provider） */
	| "api-mismatch"
	/** 命中 providers 白名单 */
	| "provider"
	/** 命中 baseUrlPatterns 域名兜底 */
	| "base-url"
	/** 两种规则都没命中 */
	| "unmatched";

export interface MatchResult {
	matched: boolean;
	reason: MatchReason;
	/** 命中或失配的具体依据，用于 status 展示 */
	detail?: string;
}

/**
 * 判定当前模型是否需要改写。三个 provider 钩子与命令共用同一份判定，顺序固定：
 * 开关 → 有模型 → 通道 → providers 白名单 → baseUrl 兜底。
 */
export class TargetMatcher {
	readonly #rules: Pick<ShimConfig, "providers" | "baseUrlPatterns">;

	constructor(rules: Pick<ShimConfig, "providers" | "baseUrlPatterns">) {
		this.#rules = rules;
	}

	evaluate(model: ModelLike | undefined, enabled: boolean): MatchResult {
		if (!enabled) return { matched: false, reason: "disabled" };
		if (!model) return { matched: false, reason: "no-model" };
		if (model.api !== ANTHROPIC_MESSAGES_API) {
			return { matched: false, reason: "api-mismatch", detail: model.api };
		}
		if (this.#rules.providers.includes(model.provider)) {
			return { matched: true, reason: "provider", detail: model.provider };
		}
		const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl : "";
		const pattern = this.#rules.baseUrlPatterns.find((p) => p.length > 0 && baseUrl.includes(p));
		if (pattern !== undefined) return { matched: true, reason: "base-url", detail: pattern };
		return { matched: false, reason: "unmatched" };
	}
}

const REASON_TEXT: Record<MatchReason, (detail?: string) => string> = {
	disabled: () => "已通过 /cc-shim off 关闭",
	"no-model": () => "尚未选择模型",
	"api-mismatch": (detail) => `当前通道为 ${detail ?? "未知"}，只处理 ${ANTHROPIC_MESSAGES_API}`,
	provider: (detail) => `provider "${detail}" 在 providers 白名单中`,
	"base-url": (detail) => `baseUrl 包含 "${detail}"`,
	unmatched: () => "provider 不在白名单，baseUrl 也未匹配任何 pattern",
};

export function describeMatch(result: MatchResult): string {
	return REASON_TEXT[result.reason](result.detail);
}
