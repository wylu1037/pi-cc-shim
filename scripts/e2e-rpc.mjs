#!/usr/bin/env node
/**
 * Drives a full session through pi's RPC mode to verify the /cc-shim commands, dump output and status tracking.
 * Called by scripts/e2e.sh; can also run standalone:
 *   PI_CODING_AGENT_DIR=<temp agent dir> node scripts/e2e-rpc.mjs <extension entry path>
 * Exit code 0 means every assertion passed.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const extension = process.argv[2];
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!extension || !agentDir) {
	console.error("usage: PI_CODING_AGENT_DIR=<dir> node scripts/e2e-rpc.mjs <extension path>");
	process.exit(2);
}

const pi = spawn(
	"pi",
	["--mode", "rpc", "--no-session", "--offline", "-ne", "-ns", "-np", "-nc", "-e", extension],
	{ stdio: ["pipe", "pipe", "inherit"] },
);

const events = [];
const waiters = [];
let buffer = "";
pi.stdout.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		events.push(event);
		for (const waiter of [...waiters]) {
			if (waiter.match(event)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(event);
			}
		}
	}
});

function waitFor(match, label, timeoutMs = 30_000) {
	const already = events.find(match);
	if (already) return Promise.resolve(already);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), timeoutMs);
		waiters.push({ match, resolve: (event) => (clearTimeout(timer), resolve(event)) });
	});
}

let seq = 0;
function send(message) {
	const id = `req-${++seq}`;
	pi.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
	return id;
}

const isNotify = (event) => event.type === "extension_ui_request" && event.method === "notify";
const notifyText = (event) => String(event.message ?? event.text ?? event.title ?? "");
const notifyIndex = () => events.filter(isNotify).length;

/** Send one extension command and wait for the next notify it produces */
async function command(text) {
	const before = notifyIndex();
	send({ type: "prompt", message: text });
	const event = await waitFor((e) => isNotify(e) && events.filter(isNotify).indexOf(e) >= before, `"${text}" 的通知`);
	return notifyText(event);
}

async function prompt(text) {
	const before = events.filter((e) => e.type === "agent_end").length;
	send({ type: "prompt", message: text });
	await waitFor((e) => e.type === "agent_end" && events.filter((x) => x.type === "agent_end").indexOf(e) >= before, `"${text}" 的 agent_end`);
}

const failures = [];
const check = (condition, label) => {
	console.log(`${condition ? "ok  " : "FAIL"} ${label}`);
	if (!condition) failures.push(label);
};

try {
	send({ type: "get_state" });
	await waitFor((e) => e.type === "response" && e.command === "get_state", "get_state 响应");

	const status1 = await command("/cc-shim status");
	check(/🟢 active/.test(status1), "status：命中当前模型");
	check(/no requests yet/.test(status1), "status：尚无请求");

	const dumpNotice = await command("/cc-shim dump");
	check(/cc-shim-last\.json/.test(dumpNotice), "dump：提示写入路径");

	await prompt("Reply with exactly: pong");
	const dumpFile = join(agentDir, "logs", "cc-shim-last.json");
	check(existsSync(dumpFile), "dump：文件已写入");
	if (existsSync(dumpFile)) {
		const snapshot = JSON.parse(readFileSync(dumpFile, "utf8"));
		check(snapshot.applied === true, "dump：applied=true");
		check(snapshot.headers?.["User-Agent"]?.startsWith("claude-cli/"), "dump：User-Agent 已改写");
		check(snapshot.headers?.["x-app"] === "cli", "dump：x-app=cli");
		check(snapshot.payload?.system?.[0]?.text?.startsWith("You are Claude Code"), "dump：system[0] 是开场句");
		check(snapshot.payload?.betas?.includes("context-1m-2025-08-07"), "dump：betas 含 context-1m");
		check(snapshot.payload?.model === "claude-fable-5-1", "dump：model 去掉了 [1m]");
		check(typeof snapshot.payload?.metadata?.user_id === "string", "dump：metadata.user_id 已设置");
		check(!JSON.stringify(snapshot).includes("fake-key"), "dump：不含 API key");
	}

	const status2 = await command("/cc-shim status");
	check(/HTTP 200/.test(status2), "status：记录到 HTTP 200");
	check(/model: claude-fable-5-1\[1m\] → claude-fable-5-1/.test(status2), "status：展示 model 改写摘要");
	check(/User-Agent/.test(status2), "status：展示请求头改写摘要");

	const offNotice = await command("/cc-shim off");
	check(/disabled \(this session only\)/.test(offNotice), "off：提示已关闭");
	await prompt("Reply with exactly: pong");
	const status3 = await command("/cc-shim status");
	check(/⚪ inactive: disabled via \/cc-shim off/.test(status3), "status：关闭后显示未生效");
	check(/HTTP 503/.test(status3), "status：关闭后记录到 relay 的 503");

	const onNotice = await command("/cc-shim on");
	check(/enabled \(this session only\)/.test(onNotice), "on：提示已启用");
	await prompt("Reply with exactly: pong");
	const status4 = await command("/cc-shim status");
	check(/HTTP 200/.test(status4), "status：重新启用后再次 200");

	const bogus = await command("/cc-shim bogus");
	check(/unknown subcommand/.test(bogus), "未知子命令：报错");
} catch (error) {
	failures.push(String(error));
	console.log(`FAIL ${String(error)}`);
} finally {
	pi.kill();
}

console.log(failures.length === 0 ? "RPC e2e PASS" : `RPC e2e FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
