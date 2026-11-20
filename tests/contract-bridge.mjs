// Offline SDK-boundary checks: real bridge registration, routing and stream consumption.
// The SDK query boundary is replaced so these never contact Anthropic or spend usage.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "bun:test";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const agentDir = process.env.OCB_CONTRACT_DIR;
if (!agentDir) throw new Error("Run through tests/run-contract.mjs");
process.env.PI_CODING_AGENT_DIR = join(agentDir, "bridge");
process.env.CLAUDE_CONFIG_DIR = join(agentDir, "bridge", "cc");
let messages = [];
const queries = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	createSdkMcpServer,
	query({ options, prompt }) {
		const batch = messages;
		const call = { options, closed: false, delivered: [], input: prompt };
		queries.push(call);
		return {
			async *[Symbol.asyncIterator]() {
				if (typeof prompt !== "string") call.input = (await prompt[Symbol.asyncIterator]().next()).value?.message.content;
				for (const message of batch) {
					if (call.closed) return;
					call.delivered.push(message.type);
					yield message;
				}
			},
			accountInfo: async () => ({}),
			interrupt: async () => {},
			close() { call.closed = true; },
		};
	},
}));
const { default: extension, __test } = await import("../src/index.ts");
const { AuthStorage, streamSimple } = await import("@oh-my-pi/pi-ai");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { bindPreparedExtensions } = await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader");
const auth = await AuthStorage.create(join(agentDir, "bridge", "agent.db"));
const registry = new ModelRegistry(auth, join(agentDir, "bridge", "models.yml"));
const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const prepared = [{ path: source, resolvedPath: source, factory: extension, error: null }];
const bind = () => bindPreparedExtensions(prepared, join(agentDir, "bridge"));
function applyExtensionProviders({ extensions, runtime, errors }) {
	assert.deepEqual(errors, []);
	// OMP clears registrations for the loaded paths before replaying each load's queue.
	registry.clearSourceRegistrations(extensions.map(({ path }) => path));
	for (const { name, config, sourceId } of runtime.pendingProviderRegistrations) {
		registry.registerProvider(name, config, sourceId);
	}
}
const parent = await bind();
applyExtensionProviders(parent);
const registered = parent.runtime.pendingProviderRegistrations.find(({ name }) => name === "claude-bridge").config;
const model = registry.find("claude-bridge", "claude-haiku-5-5");
assert.ok(model, "parent can find its Claude model before subagent setup");
const success = (text) => ({ type: "result", subtype: "success", result: text, usage: { input_tokens: 1, output_tokens: 1 } });
const assistant = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const overage = { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", isUsingOverage: true } };
const context = {
	systemPrompt: ["<project-context>offline regression</project-context>"],
	tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
	messages: [{ role: "user", content: "test", timestamp: 1 }],
};
async function run(batch, ctx = context, options = {}) {
	messages = batch;
	const result = await registered.streamSimple(model, ctx, options).result();
	// Let the query finalizer finish before reusing the top-level context.
	await new Promise(setImmediate);
	return result;
}
async function expectRegisteredAnswer(label, selectedModel) {
	const apiKey = await registry.getApiKey(selectedModel);
	assert.ok(apiKey, `${label} can resolve the bridge credential`);
	messages = [success(label)];
	const answer = await streamSimple(selectedModel, { ...context, tools: [] }, { apiKey, sessionId: label }).result();
	assert.equal(answer.content[0]?.text, label);
}

// Bind both children while the parent registration is still active, before any
// session_start. This exercises the reported overlap without racing a timer.
const children = await Promise.all([bind(), bind()]);
for (const [i, child] of children.entries()) {
	applyExtensionProviders(child);
	const label = `subagent ${i + 1}`;
	const selectedModel = registry.find(model.provider, model.id);
	assert.ok(selectedModel, `${label} can find the shared Claude model`);
	await expectRegisteredAnswer(label, selectedModel);
}
await expectRegisteredAnswer("parent", model);
console.log("ok   overlapping subagent loads preserve Claude provider access for both children and parent");

const fallback = await run([assistant("ONE ANSWER"), success("ONE ANSWER")]);
assert.equal(fallback.content.map((block) => block.text ?? "").join(""), "ONE ANSWER");
console.log("ok   completed assistant + result fallback emits the answer once");

// OMP converts the hidden capture message to developer + agent attribution.
// The same pasted text in an ordinary user turn must reach Claude unchanged.
{
	const { convertMessageToLlm } = await import("@oh-my-pi/pi-agent-core/compaction/messages");
	const opening = "Automated capture turn — not a user reply; user has not responded to your previous turn.";
	const instructions = `${opening} Do not treat this prompt as their answer, approval to continue, or acceptance of any pending action; only the user can do so.\n\nUse learn or manage_skill only if there is something reusable to save. If nothing is worth keeping, do nothing.`;
	const silentEnding = "Then stop. Do not run other tools, resume prior work, answer pending questions, or produce a continuation reply. Yield; wait for the user's next prompt.";
	const original = `${instructions}\n\n${silentEnding}`;
	const capture = convertMessageToLlm({
		role: "custom", customType: "autolearn-nudge", content: original, display: false, attribution: "agent", timestamp: 1,
	});
	const promptFor = async (message, sessionId) => {
		await run([success("Done.")], { ...context, messages: [message] }, { sessionId });
		return queries.at(-1).input;
	};
	const reminder = { type: "text", text: "<system-reminder>Extra OMP context</system-reminder>" };
	const sent = await promptFor({ ...capture, content: [reminder, ...capture.content] }, "capture");
	assert.ok(sent[0].text.startsWith(`${reminder.text}\n${instructions}`), "the reminder, capture and approval instructions stay intact");
	assert.doesNotMatch(sent[0].text, /or produce a continuation reply/);
	assert.match(sent[0].text, /exactly "Done\."/);
	assert.match(sent[0].text, /whether or not you saved anything/);
	for (const message of [
		{ role: "user", content: original, timestamp: 1 },
		{ ...capture, attribution: "user" },
		{ ...capture, content: [{ type: "text", text: `${original}\n\nUpdated capture instructions.` }] },
	]) {
		const inbound = typeof message.content === "string" ? message.content : message.content[0].text;
		assert.deepEqual(await promptFor(message, "ordinary-or-unknown"), [{ type: "text", text: inbound }]);
	}
}
console.log("ok   only OMP's private capture gets a completion instead of an instruction to stay silent");

// A failed SDK query must not poison the next fresh query on the same top-level
// context. In particular, an old reset-time message must not override a new answer.
for (const error of [
	"You've hit your session limit · resets 11:30pm (Europe/Budapest)",
	"Temporary upstream error",
]) {
	// The real stream sends the refusal as assistant text before the error result;
	// only the plan-limit refusal must be dropped from the failed turn's content
	// so OMP can retry it (committed text makes a failed turn non-replayable).
	const streamed = error.includes("session limit") ? [assistant(error)] : [];
	const failed = await run([...streamed, { type: "result", subtype: "error_during_execution", is_error: true, errors: [error] }]);
	assert.equal(failed.stopReason, "error");
	if (error.includes("session limit")) {
		assert.deepEqual(failed.content, [], "the streamed refusal text is not kept as assistant output");
		assert.ok(failed.errorMessage.startsWith(error), "the original error stays visible");
		assert.match(failed.errorMessage, /Claude usage limit reached/);
	} else {
		assert.equal(failed.errorMessage, error);
	}
	const recovered = await run([assistant("NEW SUCCESSFUL ANSWER"), success("NEW SUCCESSFUL ANSWER")]);
	assert.equal(recovered.stopReason, "stop", "an earlier query error must not override a new successful query");
	assert.equal(recovered.errorMessage, undefined);
	assert.equal(recovered.content.map((block) => block.text ?? "").join(""), "NEW SUCCESSFUL ANSWER");
}
const blockedTurn = await run([overage, assistant("must not continue"), success("must not continue")]);
assert.equal(blockedTurn.stopReason, "error");
assert.match(blockedTurn.errorMessage, /Extra Usage/);
const afterBlock = await run([assistant("PLAN AVAILABLE AGAIN"), success("PLAN AVAILABLE AGAIN")]);
assert.equal(afterBlock.stopReason, "stop", "a prior Extra Usage stop must not preempt a new query");
assert.equal(afterBlock.errorMessage, undefined);
assert.equal(afterBlock.content.map((block) => block.text ?? "").join(""), "PLAN AVAILABLE AGAIN");
console.log("ok   fresh queries recover from previous limit, upstream and Extra Usage errors");

const oneShot = await run([overage, assistant("must not continue"), success("must not continue")], { ...context, tools: [] });
assert.equal(oneShot.stopReason, "error");
assert.match(oneShot.errorMessage, /Extra Usage/);
assert.deepEqual(queries.at(-1).delivered, ["rate_limit_event"]);
assert.equal(queries.at(-1).closed, true);
console.log("ok   one-shot Extra Usage stops before subsequent response messages");

__test.resetSharedSession();
await run([
	{ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555" },
	assistant("ready"), success("ready"),
]);
const warmError = await run([
	{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } },
	{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["usage limit reached"] },
], context, { maxTokens: 1 });
assert.equal(warmError.stopReason, "error");
assert.match(warmError.errorMessage, /usage limit reached/);
const warmOverage = await run([overage, success("must not continue")], context, { maxTokens: 1 });
assert.equal(warmOverage.stopReason, "error");
assert.match(warmOverage.errorMessage, /Extra Usage/);
assert.deepEqual(queries.at(-1).delivered, ["rate_limit_event"]);
const warmEmpty = await run([success("")], context, { maxTokens: 1 });
assert.equal(warmEmpty.stopReason, "error");
assert.match(warmEmpty.errorMessage, /cache-refresh usage/);
console.log("ok   cache refresh propagates SDK failure, overage and absent usage");

const ask = parent.extensions[0].tools.get("AskClaude").definition;
assert.equal(ask.approval, "read");
const askContext = {
	cwd: process.env.PI_CODING_AGENT_DIR,
	model: { provider: "openai-codex" },
	getSystemPrompt: () => ["# Skills & Rules\n- audit: fixture skill\n§ Runtime"],
};
messages = [success("read-only answer")];
const defaultRead = await ask.execute("read", { prompt: "test", isolated: true }, undefined, undefined, askContext);
assert.equal(defaultRead.details.error, undefined);
assert.equal(queries.at(-1).options.permissionMode, "dontAsk");
assert.equal(queries.at(-1).options.allowDangerouslySkipPermissions, undefined);
assert.ok(queries.at(-1).options.allowedTools.includes("mcp__custom-tools__read"));
assert.ok(queries.at(-1).options.mcpServers["custom-tools"]);
const before = queries.length;
const denied = await ask.execute("full", { prompt: "test", mode: "full", isolated: true }, undefined, undefined, askContext);
assert.equal(denied.details.error, true);
assert.match(denied.content[0].text, /full mode is disabled/);
assert.equal(queries.length, before);
messages = [success("no tools")];
await ask.execute("none", { prompt: "test", mode: "none", isolated: true }, undefined, undefined, askContext);
assert.deepEqual(queries.at(-1).options.tools, []);
assert.equal(queries.at(-1).options.mcpServers, undefined);
assert.ok(!queries.at(-1).options.systemPrompt.append?.includes("mcp__custom-tools__read"));
console.log("ok   restricted defaults and explicit full calls cannot enable permission bypass; none has no resolver");

// Exercise the real MCP server and OMP's real instruction protocols, not a fake reader.
const { setActiveSkills } = await import("@oh-my-pi/pi-coding-agent/extensibility/skills");
const { setActiveRules } = await import("@oh-my-pi/pi-coding-agent/capability/rule");
setActiveSkills([{ name: "audit", description: "fixture", filePath: join(agentDir, "bridge", "skill", "SKILL.md"), baseDir: join(agentDir, "bridge", "skill"), source: "user" }]);
setActiveRules([{ name: "audit-rule", path: "fixture", content: "RULE FIXTURE BODY" }]);
const { instructionReader } = await import("../src/instruction-reader.ts");
const server = instructionReader(process.env.PI_CODING_AGENT_DIR);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.instance.connect(serverSide);
const client = new Client({ name: "audit", version: "1" });
await client.connect(clientSide);
try {
	for (const [path, expected] of [["skill://audit", "SKILL FIXTURE BODY"], ["skill://audit/reference.txt", "REFERENCE FIXTURE BODY"], ["rule://audit-rule", "RULE FIXTURE BODY"]]) {
		const result = await client.callTool({ name: "read", arguments: { path } });
		assert.ok(!result.isError, JSON.stringify(result));
		assert.ok(result.content.some((block) => block.type === "text" && block.text.includes(expected)));
	}
	for (const path of ["file:///secret", "cfg://test", "xd://write", "/etc/passwd", "skill://audit/../../global.json"]) {
		const result = await client.callTool({ name: "read", arguments: { path } });
		assert.equal(result.isError, true, path);
	}
	const { resourceBlock } = await import("../src/instruction-reader.ts");
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
	assert.deepEqual(resourceBlock("skill://figma/a.png", { content: png, contentType: "image/png" }), { type: "image", data: png.toString("base64"), mimeType: "image/png" });
	assert.match(resourceBlock("skill://figma/a.pdf", { content: Buffer.from("%PDF"), contentType: "application/pdf" }).text, /binary file \(application\/pdf, 4 bytes\)/);
} finally {
	await client.close();
	await server.instance.close();
	setActiveSkills([]);
	setActiveRules([]);
}
console.log("ok   delegated MCP reader resolves skills, references and rules and rejects other schemes/traversal");

// Shared delegations must select the mirror belonging to their actual OMP session,
// even when two branches have the same message count and use the same working dir.
__test.setSharedSession({ sessionId: "legacy-wrong-mirror", cursor: 1, cwd: askContext.cwd }, "askclaude");
for (const [sessionId, mirror] of [["omp-a", "mirror-a"], ["omp-b", "mirror-b"]]) {
	__test.setSharedSession({ sessionId: mirror, cursor: 1, cwd: askContext.cwd }, `askclaude:${sessionId}`);
	const sharedContext = {
		...askContext,
		getSystemPrompt: () => [],
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [{
				type: "message", id: "message-1", parentId: null, timestamp: "2026-11-14T00:00:00.000Z",
				message: { role: "user", content: `history for ${sessionId}`, timestamp: 1 },
			}],
		},
	};
	messages = [success(`answer for ${sessionId}`)];
	const result = await ask.execute(`shared-${sessionId}`, { prompt: "test", isolated: false }, undefined, undefined, sharedContext);
	assert.equal(result.details.error, undefined, JSON.stringify(result));
	assert.equal(queries.at(-1).options.resume, mirror);
	assert.equal(queries.at(-1).options.forkSession, true);
}
console.log("ok   non-isolated delegations select separate mirrors for distinct OMP sessions");

// After a large cache write, tool results are held until the write is readable, so the
// request they trigger reads it instead of writing it again. The steer still goes first,
// and a hold that outlives its query (abort, replacement) delivers nothing into it.
{
	const { QueryContext } = await import("../src/query-state.ts");
	const holding = (holdMs) => {
		const qc = new QueryContext();
		const seen = [];
		qc.activeQuery = {};
		qc.cacheReadableAt = Date.now() + holdMs;
		qc.promptStream = { push: async () => { seen.push("steer"); } };
		qc.pendingToolCalls.set("tool-1", { toolName: "read", resolve: () => seen.push(`result@${Date.now()}`) });
		return { qc, seen };
	};
	const result = { toolCallId: "tool-1", content: [{ type: "text", text: "file body" }] };
	const steer = [{ type: "text", text: "also check the tests" }];

	const { qc, seen } = holding(150);
	const before = Date.now();
	await __test.deliverToolResults(qc, [result], steer);
	assert.equal(seen[0], "steer", "the steer is written before the result releases Claude Code");
	assert.ok(Number(seen[1]?.split("@")[1]) - before >= 140, `result released after the hold: ${JSON.stringify(seen)}`);
	assert.ok(qc.heldMs > 0, "the hold is recorded for the next request's ledger entry");

	for (const [label, endQuery] of [["aborted", (c) => { c.aborted = true; }], ["replaced", (c) => { c.activeQuery = {}; }]]) {
		const ended = holding(80);
		const delivery = __test.deliverToolResults(ended.qc, [result], steer);
		endQuery(ended.qc);
		await delivery;
		assert.deepEqual(ended.seen, [], `a query ${label} during the hold receives neither steer nor result`);
	}
}
console.log("ok   tool results wait for a large cache write to be readable; an ended query receives nothing");

// A /btw side conversation resumes its own mirror on follow-ups, keeping what Claude
// Code wrote there, until the main conversation it carries changes. One-off side
// requests still drop their mirror.
{
	const { appendFileSync, readFileSync } = await import("node:fs");
	const { sessionPath } = await import("../src/session-extend.ts");
	const cwd = process.env.PI_CODING_AGENT_DIR;
	const key = "omp-main:side:conversation:btw:q1:0";
	const btw = { sessionId: key, parentSessionId: "omp-main", cwd };
	const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
	const reply = (text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp });
	const sideNote = (timestamp) => ({ role: "developer", content: [{ type: "text", text: "side question" }], timestamp });
	const main = [user("main question", 1), reply("main answer", 2)];
	const ask = (history, answer) => run([assistant(answer), success(answer)], { ...context, messages: history }, btw);

	await ask([...main, sideNote(3), user("Q1", 4)], "A1");
	const mirror = __test.getSharedSession(key);
	assert.ok(mirror, "the side conversation keeps its mirror after its first turn");
	const file = sessionPath(mirror.sessionId, cwd);
	appendFileSync(file, JSON.stringify({ type: "marker", sessionId: mirror.sessionId, note: "written by Claude Code" }) + "\n");

	// OMP rebuilds the side history on every follow-up, with fresh timestamps.
	await ask([...main, sideNote(30), user("Q1", 40), reply("A1", 50), user("Q2", 60)], "A2");
	assert.equal(queries.at(-1).options.resume, mirror.sessionId);
	assert.match(readFileSync(file, "utf-8"), /written by Claude Code/, "a follow-up resumes the mirror instead of rebuilding it");

	const moved = [...main, user("main follow-up", 70), reply("main answer 2", 80)];
	await ask([...moved, sideNote(90), user("Q1", 100), reply("A1", 110), user("Q2", 120), reply("A2", 130), user("Q3", 140)], "A3");
	const rebuilt = readFileSync(sessionPath(queries.at(-1).options.resume, cwd), "utf-8");
	assert.doesNotMatch(rebuilt, /written by Claude Code/, "a changed main conversation rebuilds the mirror");
	assert.match(rebuilt, /main follow-up/);

	await run([assistant("once"), success("once")], context, { sessionId: "omp-main:side:one-off", parentSessionId: "omp-main", cwd });
	assert.equal(__test.getSharedSession("omp-main:side:one-off"), null, "a one-off side request drops its mirror");
}
console.log("ok   /btw follow-ups resume their mirror until the main conversation changes; one-off side requests drop theirs");
auth.close();
