import type { ShimConfig } from "./config.ts";
import type { ModelLike } from "./types.ts";

export const ANTHROPIC_MESSAGES_API = "anthropic-messages";

export type MatchReason =
	/** Disabled in this session via /cc-shim off */
	| "disabled"
	/** No model selected yet */
	| "no-model"
	/** Not the anthropic-messages api (e.g. an openai-responses provider on the same host that goes through codex) */
	| "api-mismatch"
	/** Matched the providers allowlist */
	| "provider"
	/** Matched the baseUrlPatterns fallback */
	| "base-url"
	/** Neither rule matched */
	| "unmatched";

export interface MatchResult {
	matched: boolean;
	reason: MatchReason;
	/** Concrete evidence for the match or mismatch, shown by status */
	detail?: string;
}

/**
 * Decides whether the current model needs rewriting. The three provider hooks and the command share this one decision, in a fixed order:
 * switch → model present → api → providers allowlist → baseUrl fallback.
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
	disabled: () => "disabled via /cc-shim off",
	"no-model": () => "no model selected",
	"api-mismatch": (detail) => `api is ${detail ?? "unknown"}, only ${ANTHROPIC_MESSAGES_API} is handled`,
	provider: (detail) => `provider "${detail}" is in the providers allowlist`,
	"base-url": (detail) => `baseUrl contains "${detail}"`,
	unmatched: () => "provider not in allowlist and baseUrl matches no pattern",
};

export function describeMatch(result: MatchResult): string {
	return REASON_TEXT[result.reason](result.detail);
}
