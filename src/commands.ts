import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig, ShimPaths } from "./config.ts";
import type { DumpRecorder } from "./dump.ts";
import { describeMatch, type TargetMatcher } from "./matcher.ts";
import type { SessionState } from "./state.ts";
import type { ModelLike } from "./types.ts";

export interface CommandDeps {
	state: SessionState;
	loaded: LoadedConfig;
	paths: ShimPaths;
	matcher: TargetMatcher;
	dump: DumpRecorder;
	/** 开关变化后刷新页脚等 UI，由组合根注入 */
	refresh: (ctx: ExtensionCommandContext) => void;
}

interface Subcommand {
	description: string;
	run(ctx: ExtensionCommandContext, deps: CommandDeps): void;
}

export function formatStatus(deps: CommandDeps, model: ModelLike | undefined): string {
	const { state, loaded, paths } = deps;
	const match = deps.matcher.evaluate(model, state.enabled);
	const lines: string[] = [
		`pi-cc-shim ${match.matched ? "✓ 生效中" : "○ 未生效"}：${describeMatch(match)}`,
		`模型：${model ? `${model.provider} / ${model.id}（${model.api}，${model.baseUrl}）` : "未选择"}`,
		`配置：${loaded.source === "file" ? paths.configFile : `内置默认值（${paths.configFile} 不存在）`}`,
	];
	if (loaded.warnings.length > 0) lines.push(`配置警告：${loaded.warnings.join("；")}`);

	const last = state.lastStatus;
	if (!last) lines.push("上次响应：尚无请求");
	else {
		const code = last.code === undefined ? "状态码未知" : `HTTP ${last.code}`;
		const extra = [last.model, last.message].filter(Boolean).join("，");
		lines.push(`上次响应：${code}（${last.at}${extra ? `，${extra}` : ""}）`);
	}

	if (state.lastInjection) {
		lines.push(`上次注入（${state.lastInjection.model}，${state.lastInjection.at}）：`);
		lines.push(...state.lastInjection.summaries.map((summary) => `  - ${summary}`));
	}
	if (deps.dump.armed) lines.push(`dump：已就绪，下一次请求写入 ${paths.dumpFile}`);
	return lines.join("\n");
}

/** 子命令表：新增子命令只需加一项，分发逻辑不变（命令模式） */
const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
	status: {
		description: "显示命中情况、上次响应状态与注入内容",
		run: (ctx, deps) => ctx.ui.notify(formatStatus(deps, ctx.model), "info"),
	},
	on: {
		description: "本会话启用",
		run: (ctx, deps) => {
			deps.state.enabled = true;
			deps.refresh(ctx);
			ctx.ui.notify("cc-shim: 已启用（仅本会话）", "info");
		},
	},
	off: {
		description: "本会话关闭",
		run: (ctx, deps) => {
			deps.state.enabled = false;
			deps.refresh(ctx);
			ctx.ui.notify("cc-shim: 已关闭（仅本会话）", "info");
		},
	},
	dump: {
		description: "把下一次请求的最终 payload 与请求头（脱敏）写到日志文件",
		run: (ctx, deps) => {
			deps.dump.arm();
			ctx.ui.notify(`cc-shim: 下一次请求将写入 ${deps.paths.dumpFile}`, "info");
		},
	},
};

const SUBCOMMAND_NAMES = Object.keys(SUBCOMMANDS);

export function createShimCommand(deps: CommandDeps) {
	return {
		description: `pi-cc-shim：${SUBCOMMAND_NAMES.join(" | ")}`,
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMAND_NAMES.filter((name) => name.startsWith(prefix.trim())).map((name) => ({
				value: name,
				label: name,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const name = args.trim().split(/\s+/)[0] || "status";
			const subcommand = SUBCOMMANDS[name];
			if (!subcommand) {
				ctx.ui.notify(`cc-shim: 未知子命令 "${name}"，可用：${SUBCOMMAND_NAMES.join(", ")}`, "error");
				return;
			}
			subcommand.run(ctx, deps);
		},
	};
}
