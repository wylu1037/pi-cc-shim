import type { ProviderHeaders } from "./types.ts";

/**
 * Case-insensitively override one request header.
 *
 * event.headers may already contain the same name with different casing (from models.json headers or pi's attribution headers).
 * pi-ai then merges with Object.assign (case-sensitive) and the SDK normalizes case-insensitively;
 * only by explicitly setting the other spellings to null (pi's convention: null = delete) can we guarantee ours is the only value left.
 */
export function setHeader(headers: ProviderHeaders, name: string, value: string): void {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key !== name && key.toLowerCase() === lower) headers[key] = null;
	}
	headers[name] = value;
}

export function getHeader(headers: ProviderHeaders, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower && value !== null) return value;
	}
	return undefined;
}

export class HeaderRewriter {
	readonly #overrides: Readonly<Record<string, string>>;

	constructor(overrides: Readonly<Record<string, string>>) {
		this.#overrides = overrides;
	}

	/** Mutates in place (pi ignores this hook's return value); returns a change summary per header */
	apply(headers: ProviderHeaders): string[] {
		const summaries: string[] = [];
		for (const [name, value] of Object.entries(this.#overrides)) {
			const before = getHeader(headers, name);
			setHeader(headers, name, value);
			if (before === undefined) summaries.push(`${name}: set to "${value}"`);
			else if (before === value) summaries.push(`${name}: already "${value}"`);
			else summaries.push(`${name}: "${before}" → "${value}"`);
		}
		return summaries;
	}
}
