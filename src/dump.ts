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
 * One-shot snapshot for /cc-shim dump.
 * The headers hook and the request hook are two callbacks fired in sequence for the same request, so headers are buffered first and written together once the payload arrives.
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

	/** When armed, writes the file, returns its path and disarms; otherwise does nothing */
	captureRequest(snapshot: Omit<DumpSnapshot, "capturedAt" | "headers">): string | undefined {
		if (!this.#armed) return undefined;
		const full: DumpSnapshot = { capturedAt: new Date().toISOString(), ...snapshot, headers: this.#headers };
		this.#write(this.filePath, JSON.stringify(full, null, 2));
		this.#armed = false;
		this.#headers = undefined;
		return this.filePath;
	}
}
