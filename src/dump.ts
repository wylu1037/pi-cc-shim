import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelLike, ProviderHeaders } from "./types.ts";

const SECRET_HEADERS = /^(authorization|x-api-key|x-goog-api-key|api-key|proxy-authorization)$/i;

export function redactHeaders(headers: ProviderHeaders): ProviderHeaders {
	const out: ProviderHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		out[name] = value !== null && SECRET_HEADERS.test(name) ? "<redacted>" : value;
	}
	return out;
}

export interface DumpSnapshot {
	capturedAt: string;
	model?: ModelLike;
	applied: boolean;
	matchReason: string;
	summaries: string[];
	headers?: ProviderHeaders;
	payload: unknown;
}

export type SnapshotWriter = (path: string, content: string) => void;

const writeToDisk: SnapshotWriter = (path, content) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
};

/**
 * /cc-shim dump 的一次性快照。
 * headers 钩子和 request 钩子是同一请求内先后触发的两次回调，所以先暂存请求头，再在拿到 payload 时一起落盘。
 */
export class DumpRecorder {
	readonly filePath: string;
	readonly #write: SnapshotWriter;
	#armed = false;
	#headers: ProviderHeaders | undefined;

	constructor(filePath: string, write: SnapshotWriter = writeToDisk) {
		this.filePath = filePath;
		this.#write = write;
	}

	get armed(): boolean {
		return this.#armed;
	}

	arm(): void {
		this.#armed = true;
		this.#headers = undefined;
	}

	captureHeaders(headers: ProviderHeaders): void {
		if (this.#armed) this.#headers = redactHeaders(headers);
	}

	/** 已武装时写文件并返回路径，随后自动解除；未武装时什么都不做 */
	captureRequest(snapshot: Omit<DumpSnapshot, "capturedAt" | "headers">): string | undefined {
		if (!this.#armed) return undefined;
		const full: DumpSnapshot = { capturedAt: new Date().toISOString(), ...snapshot, headers: this.#headers };
		this.#write(this.filePath, JSON.stringify(full, null, 2));
		this.#armed = false;
		this.#headers = undefined;
		return this.filePath;
	}
}
