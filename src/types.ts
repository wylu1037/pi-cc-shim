/**
 * Minimal set of types this extension touches.
 * The payload is pi-ai's serialized Anthropic request; only the fields we read or write are declared, everything else passes through untouched.
 */

export interface TextBlock {
	type: "text";
	text: string;
	cache_control?: unknown;
	[key: string]: unknown;
}

export interface ToolDefinition {
	name: string;
	description?: string;
	input_schema?: unknown;
	[key: string]: unknown;
}

export interface AnthropicPayload {
	model?: string;
	/** pi normally emits an array of blocks; other extensions may turn it into a string, so both must be handled */
	system?: string | TextBlock[];
	tools?: ToolDefinition[];
	metadata?: Record<string, unknown>;
	/** pi-ai puts this at the top level of the payload; the SDK turns it into the anthropic-beta header when sending */
	betas?: string[];
	[key: string]: unknown;
}

/** Fields of ctx.model needed for matching and for the dump snapshot */
export interface ModelLike {
	provider: string;
	api: string;
	baseUrl: string;
	id: string;
	name?: string;
}

/** Same as pi's ProviderHeaders: a null value means delete the header */
export type ProviderHeaders = Record<string, string | null>;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
