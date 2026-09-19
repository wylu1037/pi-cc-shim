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
	/** Refresh footer and other UI after the toggle changes; injected by the composition root */
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
		`🛂 pi-cc-shim ${match.matched ? "🟢 active" : "⚪ inactive"}: ${describeMatch(match)}`,
		`🤖 Model: ${model ? `${model.provider} / ${model.id} (${model.api}, ${model.baseUrl})` : "none selected"}`,
		`🔧 Config: ${loaded.source === "file" ? paths.configFile : `built-in defaults (${paths.configFile} not found)`}`,
	];
	if (loaded.warnings.length > 0) lines.push(`⚠️ Config warnings: ${loaded.warnings.join("; ")}`);

	const last = state.lastStatus;
	if (!last) lines.push("📡 Last response: no requests yet");
	else {
		const code = last.code === undefined ? "status unknown" : `HTTP ${last.code}`;
		const extra = [last.model, last.message].filter(Boolean).join(", ");
		lines.push(`📡 Last response: ${code} (${last.at}${extra ? `, ${extra}` : ""})`);
	}

	if (state.lastInjection) {
		lines.push(`💉 Last injection (${state.lastInjection.model}, ${state.lastInjection.at}):`);
		lines.push(...state.lastInjection.summaries.map((summary) => `  - ${summary}`));
	}
	if (deps.dump.armed) lines.push(`📝 Dump: armed, next request will be written to ${paths.dumpFile}`);
	return lines.join("\n");
}

/** Subcommand table: adding a subcommand is one new entry, dispatch stays unchanged (command pattern) */
const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
	status: {
		description: "Show match state, last response status and what was injected",
		run: (ctx, deps) => ctx.ui.notify(formatStatus(deps, ctx.model), "info"),
	},
	on: {
		description: "Enable for this session",
		run: (ctx, deps) => {
			deps.state.enabled = true;
			deps.refresh(ctx);
			ctx.ui.notify("cc-shim: enabled (this session only)", "info");
		},
	},
	off: {
		description: "Disable for this session",
		run: (ctx, deps) => {
			deps.state.enabled = false;
			deps.refresh(ctx);
			ctx.ui.notify("cc-shim: disabled (this session only)", "info");
		},
	},
	dump: {
		description: "Write the next request's final payload and headers (auth redacted) to a log file",
		run: (ctx, deps) => {
			deps.dump.arm();
			ctx.ui.notify(`cc-shim: next request will be written to ${deps.paths.dumpFile}`, "info");
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
				ctx.ui.notify(`cc-shim: unknown subcommand "${name}", available: ${SUBCOMMAND_NAMES.join(", ")}`, "error");
				return;
			}
			subcommand.run(ctx, deps);
		},
	};
}
