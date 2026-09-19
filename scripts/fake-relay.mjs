#!/usr/bin/env node
/**
 * Local fake relay: mirrors anyrouter's Claude Code fingerprint checks (see Troubleshooting in README.md),
 * used by the offline end-to-end test (scripts/e2e.sh). When the checks pass it replies with a minimal Anthropic SSE stream ("pong").
 *
 * Usage: PORT=8787 node scripts/fake-relay.mjs
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const CC_SENTENCE = "You are Claude Code, Anthropic's official CLI for Claude.";
const REQUIRED_BETA = "context-1m-2025-08-07";
const CC_TOOLS = new Set([
	"Agent", "Bash", "Edit", "Read", "Write", "Glob", "Grep",
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "KillShell", "NotebookEdit",
	"Skill", "Task", "TaskOutput", "TodoWrite", "WebFetch", "WebSearch",
]);

/** Returns [status, reason], in the same order as the observed rule table */
function check(body, headers) {
	const system = typeof body.system === "string" ? [{ type: "text", text: body.system }] : Array.isArray(body.system) ? body.system : [];
	if (!system.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.includes(CC_SENTENCE))) {
		return [503, "system 缺少 Claude Code 开场句"];
	}
	let uid;
	try {
		uid = JSON.parse(body.metadata?.user_id ?? "");
	} catch {
		return [503, "metadata.user_id 不是 JSON 串"];
	}
	if (!/^[0-9a-f]{64}$/.test(uid?.device_id ?? "") || typeof uid.session_id !== "string" || !("account_uuid" in uid)) {
		return [503, "metadata.user_id 字段不符"];
	}
	const ccCount = (Array.isArray(body.tools) ? body.tools : []).filter((t) => CC_TOOLS.has(t?.name)).length;
	if (ccCount < 4) return [520, `Claude Code 工具名不足 4 个（当前 ${ccCount}）`];
	if (/\[1m\]$/i.test(body.model ?? "")) return [429, "model 带 [1M] 后缀"];
	const betas = String(headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim());
	if (!betas.includes(REQUIRED_BETA)) return [400, `anthropic-beta 缺少 ${REQUIRED_BETA}（当前 "${headers["anthropic-beta"] ?? ""}"）`];
	return [200, "ok"];
}

const streamPong = (res, model) => streamText(res, model, "pong");

function streamText(res, model, text) {
	const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	send("message_start", {
		type: "message_start",
		message: { id: "msg_fake", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } },
	});
	send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
	send("content_block_stop", { type: "content_block_stop", index: 0 });
	send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
	send("message_stop", { type: "message_stop" });
	res.end();
}

/** Makes the model "accidentally" call the decoy tool Read, to verify pi-cc-shim's toolResult rewrite */
function streamDecoyToolUse(res, model) {
	const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	send("message_start", {
		type: "message_start",
		message: { id: "msg_fake_tool", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } },
	});
	send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_decoy_1", name: "Read", input: {} } });
	send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
	send("content_block_stop", { type: "content_block_stop", index: 0 });
	send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
	send("message_stop", { type: "message_stop" });
	res.end();
}

/** Extract the tool_result text from the last user message, or undefined if there is none */
function lastToolResultText(messages) {
	const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
	if (!last || last.role !== "user" || !Array.isArray(last.content)) return undefined;
	const result = last.content.find((block) => block?.type === "tool_result");
	if (!result) return undefined;
	if (typeof result.content === "string") return result.content;
	return (result.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

function lastUserText(messages) {
	const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
	if (!last || last.role !== "user") return "";
	if (typeof last.content === "string") return last.content;
	return (last.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

createServer((req, res) => {
	if (req.method !== "POST" || !(req.url ?? "").startsWith("/v1/messages")) {
		res.writeHead(404);
		res.end();
		return;
	}
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			res.writeHead(400);
			res.end("bad json");
			return;
		}
		const [status, reason] = check(body, req.headers);
		const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.name).join(",");
		console.error(`[fake-relay] ${status} ${reason} | model=${body.model} | tools=${tools} | ua=${req.headers["user-agent"] ?? ""} | x-app=${req.headers["x-app"] ?? ""}`);
		if (status !== 200) {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { type: "fingerprint_check", message: reason } }));
			return;
		}
		// Script: user says call-decoy → reply with a tool_use for Read; on tool_result → echo its text; otherwise → pong
		const toolResultText = lastToolResultText(body.messages);
		if (toolResultText !== undefined) streamText(res, body.model, `tool_result: ${toolResultText}`);
		else if (lastUserText(body.messages).includes("call-decoy")) streamDecoyToolUse(res, body.model);
		else streamPong(res, body.model);
	});
}).listen(PORT, "127.0.0.1", () => console.error(`[fake-relay] listening on http://127.0.0.1:${PORT}`));
