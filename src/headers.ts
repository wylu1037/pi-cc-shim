import type { ProviderHeaders } from "./types.ts";

/**
 * 大小写不敏感地覆盖一个请求头。
 *
 * event.headers 里可能已有同名但大小写不同的键（来自 models.json 的 headers 或 pi 的归因头）。
 * 后续 pi-ai 用 Object.assign 合并（区分大小写），SDK 再按大小写不敏感规整；
 * 只有把其它写法显式置为 null（pi 约定 null = 删除），最终才能保证只剩我们的值。
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

	/** 原地改写（pi 忽略该钩子的返回值），返回每个头的变更摘要 */
	apply(headers: ProviderHeaders): string[] {
		const summaries: string[] = [];
		for (const [name, value] of Object.entries(this.#overrides)) {
			const before = getHeader(headers, name);
			setHeader(headers, name, value);
			if (before === undefined) summaries.push(`${name}: 设为 "${value}"`);
			else if (before === value) summaries.push(`${name}: 已是 "${value}"`);
			else summaries.push(`${name}: "${before}" → "${value}"`);
		}
		return summaries;
	}
}
