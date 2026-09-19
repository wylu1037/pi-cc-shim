export interface StatusRecord {
	/** HTTP 状态码；从错误文本里解析不出来时为空 */
	code?: number;
	at: string;
	/** response = after_provider_response 看到的成功响应；error = 从 assistant 错误消息解析 */
	source: "response" | "error";
	model?: string;
	message?: string;
}

export interface InjectionRecord {
	at: string;
	model: string;
	summaries: string[];
}

/** 会话级状态；/new、/resume 等触发 session_start 时整体重置 */
export interface SessionState {
	enabled: boolean;
	lastStatus?: StatusRecord;
	lastInjection?: InjectionRecord;
	/** 最近一次请求里由本扩展追加的空壳工具名，用于识别模型误调 */
	decoyNames: ReadonlySet<string>;
	/** 已提醒过的拒绝状态码，避免 pi 重试期间刷屏；成功响应后清零 */
	alertedStatus?: number;
}

export function createSessionState(enabled: boolean): SessionState {
	return { enabled, decoyNames: new Set() };
}

export function resetSessionState(state: SessionState, enabled: boolean): void {
	state.enabled = enabled;
	state.lastStatus = undefined;
	state.lastInjection = undefined;
	state.decoyNames = new Set();
	state.alertedStatus = undefined;
}
