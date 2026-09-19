/**
 * pi-cc-shim: lets pi reach Claude models through relays such as anyrouter that only admit Claude Code traffic.
 *
 * This file only wires hooks together; all rewriting logic lives in pure functions under ../src.
 * The relay checks each rule answers are listed under Troubleshooting in README.md.
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

/** Pick only the fields needed for matching and snapshots, so auth headers from models.json never end up in the dump */
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
	/** The headers hook fires before the request hook; its summaries are buffered and merged into the same injection record */
	let pendingHeaderSummaries: string[] = [];

	const evaluate = (ctx: ExtensionContext) => matcher.evaluate(toModelLike(ctx.model), state.enabled);

	const refreshFooter = (ctx: ExtensionContext): void => {
		const match = evaluate(ctx);
		const text = match.matched ? "cc-shim 🟢" : match.reason === "disabled" ? "cc-shim ⚪" : undefined;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	pi.on("session_start", (event, ctx) => {
		resetSessionState(state, config.enabled);
		pendingHeaderSummaries = [];
		if (loaded.warnings.length > 0 && (event.reason === "startup" || event.reason === "reload")) {
			ctx.ui.notify(`cc-shim config warnings:\n${loaded.warnings.join("\n")}`, "warning");
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
		if (written) ctx.ui.notify(`cc-shim: written to ${written}`, "info");
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
