/**
 * 本扩展会触碰到的最小类型集合。
 * payload 来自 pi-ai 的 Anthropic 序列化结果，这里只声明会读写的字段，其余原样透传。
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
	/** pi 正常情况下产出 block 数组；其它扩展可能改成字符串，两种都要能处理 */
	system?: string | TextBlock[];
	tools?: ToolDefinition[];
	metadata?: Record<string, unknown>;
	/** pi-ai 把它放在 payload 顶层，SDK 发请求时转成 anthropic-beta 头 */
	betas?: string[];
	[key: string]: unknown;
}

/** ctx.model 中判定命中与写快照所需的字段 */
export interface ModelLike {
	provider: string;
	api: string;
	baseUrl: string;
	id: string;
	name?: string;
}

/** 与 pi 的 ProviderHeaders 一致：值为 null 表示删除该头 */
export type ProviderHeaders = Record<string, string | null>;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
