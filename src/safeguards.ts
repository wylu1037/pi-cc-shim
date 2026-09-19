import { suggestAlternative } from "./payload.ts";

/**
 * Response-side safeguards:
 * 1. Relay rejections (503/520) never reach after_provider_response (the SDK throws on non-2xx),
 *    so the status code can only be parsed from the assistant error message;
 * 2. When the model calls a decoy tool, pi emits "Tool X not found" directly and the tool_call hook never fires,
 *    so the only option is to rewrite that toolResult into a useful hint in message_end.
 */

export const RELAY_REJECTION_STATUSES: ReadonlySet<number> = new Set([503, 520]);

/** The SDK's APIError.message looks like "503 Service Unavailable"; pi-ai puts it verbatim into assistant.errorMessage */
export function extractHttpStatus(errorMessage: string | undefined): number | undefined {
	const match = /^\s*(\d{3})(?=\s|$)/.exec(errorMessage ?? "");
	const code = match?.[1];
	return code === undefined ? undefined : Number(code);
}

export function isRelayRejection(status: number | undefined): boolean {
	return status !== undefined && RELAY_REJECTION_STATUSES.has(status);
}

/** Hint written for the model to read */
export function buildDecoyHint(toolName: string, activeTools: readonly string[]): string {
	const alternative = suggestAlternative(toolName, activeTools);
	const redirect = alternative ? `Call \`${alternative}\` instead.` : "Do not call it again.";
	return `\`${toolName}\` is a compatibility placeholder injected by pi-cc-shim and cannot be executed. ${redirect}`;
}

export function rejectionAdvice(status: number): string {
	return `cc-shim: relay returned ${status}, request still rejected; its checks may have changed. Run /cc-shim dump, resend, then inspect the dump or bisect with scripts/probe-relay.sh.`;
}
