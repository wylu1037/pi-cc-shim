/**
 * pi-cc-shim：让 pi 经由 anyrouter 这类"只放行 Claude Code 流量"的 relay 访问 Claude 模型。
 *
 * 这里只做装配与钩子接线，改写逻辑都在 ../src 下的纯函数里。
 * 设计说明见 docs/pi-cc-shim-design.md，relay 校验规则见 docs/relay-rules.md。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createShimCommand } from "../src/commands.ts";
import { loadConfig, resolvePaths } from "../src/config.ts";
import { DumpRecorder } from "../src/dump.ts";
import { HeaderRewriter } from "../src/headers.ts";
import { localDeviceId } from "../src/identity.ts";
import { describeMatch, TargetMatcher } from "../src/matcher.ts";
import { addedToolNames, createPayloadRewriter } from "../src/payload.ts";
import { buildDecoyHint, extractHttpStatus, isRelayRejection, rejectionAdvice } from "../src/safeguards.ts";
import { createSessionState, resetSessionState } from "../src/state.ts";
import { isRecord, type AnthropicPayload, type ModelLike } from "../src/types.ts";

const STATUS_KEY = "cc-shim";

function now(): string {
	return new Date().toISOString();
}

/** 只取判定与快照需要的字段，避免把 models.json 里的鉴权头一起写进 dump */
function toModelLike(model: ExtensionContext["model"]): ModelLike | undefined {
	if (!model) return undefined;
	return { provider: model.provider, api: model.api, baseUrl: model.baseUrl, id: model.id, name: model.name };
}

export default function ccShim(pi: ExtensionAPI): void {
	const paths = resolvePaths(getAgentDir());
	const loaded = loadConfig(paths.configFile);
	const config = loaded.config;

	const state = createSessionState(config.enabled);
	const matcher = new TargetMatcher(config);
	const rewriter = createPayloadRewriter(config);
	const headerRewriter = new HeaderRewriter(config.headers);
	const dump = new DumpRecorder(paths.dumpFile);
	const deviceId = localDeviceId();
	/** headers 钩子先于 request 钩子触发，摘要暂存后并入同一条注入记录 */
	let pendingHeaderSummaries: string[] = [];

	const evaluate = (ctx: ExtensionContext) => matcher.evaluate(toModelLike(ctx.model), state.enabled);

	const refreshFooter = (ctx: ExtensionContext): void => {
		const match = evaluate(ctx);
		const text = match.matched ? "cc-shim ✓" : match.reason === "disabled" ? "cc-shim off" : undefined;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	pi.on("session_start", (event, ctx) => {
		resetSessionState(state, config.enabled);
		pendingHeaderSummaries = [];
		if (loaded.warnings.length > 0 && (event.reason === "startup" || event.reason === "reload")) {
			ctx.ui.notify(`cc-shim 配置警告：\n${loaded.warnings.join("\n")}`, "warning");
		}
		refreshFooter(ctx);
	});

	pi.on("model_select", (_event, ctx) => refreshFooter(ctx));

	pi.on("before_provider_headers", (event, ctx) => {
		pendingHeaderSummaries = [];
		if (evaluate(ctx).matched) pendingHeaderSummaries = headerRewriter.apply(event.headers);
		dump.captureHeaders(event.headers);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const match = evaluate(ctx);
		const model = toModelLike(ctx.model);
		const headerSummaries = pendingHeaderSummaries;
		pendingHeaderSummaries = [];

		if (!match.matched || !isRecord(event.payload)) {
			dump.captureRequest({ model, applied: false, matchReason: describeMatch(match), summaries: [], payload: event.payload });
			return undefined;
		}

		const before = event.payload as AnthropicPayload;
		const { payload, summaries: payloadSummaries } = rewriter.rewrite(before, {
			deviceId,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		const summaries = [...payloadSummaries, ...headerSummaries];
		state.decoyNames = new Set(addedToolNames(before, payload));
		state.lastInjection = { at: now(), model: model?.id ?? "?", summaries };

		const written = dump.captureRequest({ model, applied: true, matchReason: describeMatch(match), summaries, payload });
		if (written) ctx.ui.notify(`cc-shim: 已写入 ${written}`, "info");
		return payload;
	});

	pi.on("after_provider_response", (event, ctx) => {
		state.lastStatus = { code: event.status, at: now(), source: "response", model: ctx.model?.id };
		state.alertedStatus = undefined;
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;

		if (message.role === "assistant" && message.stopReason === "error") {
			const status = extractHttpStatus(message.errorMessage);
			state.lastStatus = {
				code: status,
				at: now(),
				source: "error",
				model: ctx.model?.id,
				message: (message.errorMessage ?? "").slice(0, 160),
			};
			if (isRelayRejection(status) && evaluate(ctx).matched && state.alertedStatus !== status) {
				state.alertedStatus = status;
				ctx.ui.notify(rejectionAdvice(status as number), "warning");
			}
			return undefined;
		}

		if (
			config.decoyToolHints &&
			message.role === "toolResult" &&
			message.isError &&
			state.decoyNames.has(message.toolName)
		) {
			const text = buildDecoyHint(message.toolName, pi.getActiveTools());
			return { message: { ...message, content: [{ type: "text", text }] } };
		}
		return undefined;
	});

	pi.registerCommand("cc-shim", createShimCommand({ state, loaded, paths, matcher, dump, refresh: refreshFooter }));
}
