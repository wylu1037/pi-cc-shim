import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

/** device_id is stable per machine: hex of sha256(hostname:username), matching Claude Code's 64-char hex shape */
export function computeDeviceId(host: string, user: string): string {
	return createHash("sha256").update(`${host}:${user}`).digest("hex");
}

export function localDeviceId(): string {
	let user = "unknown";
	try {
		user = userInfo().username;
	} catch {
		// Some container environments have no passwd entry; a fixed fallback is fine, it only affects the synthesized id
	}
	return computeDeviceId(hostname(), user);
}

/** Claude Code's metadata.user_id is a JSON string; keep the same field order */
export function buildUserId(deviceId: string, sessionId: string): string {
	return JSON.stringify({ device_id: deviceId, account_uuid: "", session_id: sessionId });
}
