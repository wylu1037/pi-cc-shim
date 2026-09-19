import { suggestAlternative } from "./payload.ts";

/**
 * 响应侧兜底：
 * 1. relay 拒绝（503/520）不会到达 after_provider_response（SDK 对非 2xx 直接抛错），
 *    只能从 assistant 错误消息里解析状态码；
 * 2. 模型误调诱饵工具时 pi 会直接产出 "Tool X not found"，tool_call 钩子根本不触发，
 *    只能在 message_end 里把这条 toolResult 改写成有用的提示。
 */

export const RELAY_REJECTION_STATUSES: ReadonlySet<number> = new Set([503, 520]);

/** SDK 的 APIError.message 形如 "503 Service Unavailable"，pi-ai 原样放进 assistant.errorMessage */
export function extractHttpStatus(errorMessage: string | undefined): number | undefined {
	const match = /^\s*(\d{3})(?=\s|$)/.exec(errorMessage ?? "");
	const code = match?.[1];
	return code === undefined ? undefined : Number(code);
}

export function isRelayRejection(status: number | undefined): boolean {
	return status !== undefined && RELAY_REJECTION_STATUSES.has(status);
}

/** 写给模型看的提示，因此用英文 */
export function buildDecoyHint(toolName: string, activeTools: readonly string[]): string {
	const alternative = suggestAlternative(toolName, activeTools);
	const redirect = alternative ? `Call \`${alternative}\` instead.` : "Do not call it again.";
	return `\`${toolName}\` is a compatibility placeholder injected by pi-cc-shim and cannot be executed. ${redirect}`;
}

export function rejectionAdvice(status: number): string {
	return `cc-shim: relay 返回 ${status}，请求仍被拒绝，校验规则可能已变化。运行 /cc-shim dump 后重发一次，再对照 docs/relay-rules.md 排查。`;
}
