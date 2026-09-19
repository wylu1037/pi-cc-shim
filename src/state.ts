export interface StatusRecord {
	/** HTTP status code; undefined when it cannot be parsed from the error text */
	code?: number;
	at: string;
	/** response = successful response seen by after_provider_response; error = parsed from the assistant error message */
	source: "response" | "error";
	model?: string;
	message?: string;
}

export interface InjectionRecord {
	at: string;
	model: string;
	summaries: string[];
}

/** Session-level state; fully reset whenever session_start fires (/new, /resume, etc.) */
export interface SessionState {
	enabled: boolean;
	lastStatus?: StatusRecord;
	lastInjection?: InjectionRecord;
	/** Stub tool names this extension appended to the last request, used to detect stray model calls */
	decoyNames: ReadonlySet<string>;
	/** Rejection status already alerted on, to avoid spamming during pi retries; cleared after a successful response */
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
