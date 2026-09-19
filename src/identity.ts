import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

/** device_id 按机器稳定：sha256(hostname:username) 的 hex，与 Claude Code 的 64 位 hex 形态一致 */
export function computeDeviceId(host: string, user: string): string {
	return createHash("sha256").update(`${host}:${user}`).digest("hex");
}

export function localDeviceId(): string {
	let user = "unknown";
	try {
		user = userInfo().username;
	} catch {
		// 某些容器环境没有 passwd 记录，退回固定值即可，只影响伪造 id 的取值
	}
	return computeDeviceId(hostname(), user);
}

/** Claude Code 的 metadata.user_id 是一段 JSON 字符串，字段顺序与其保持一致 */
export function buildUserId(deviceId: string, sessionId: string): string {
	return JSON.stringify({ device_id: deviceId, account_uuid: "", session_id: sessionId });
}
