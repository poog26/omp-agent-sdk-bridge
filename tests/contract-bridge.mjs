// Offline SDK-boundary checks: real bridge registration, routing and stream consumption.
// The SDK query boundary is replaced so these never contact Anthropic or spend usage.
import assert from "node:assert/strict";
import { join } from "node:path";
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
	query({ options }) {
		const batch = messages;
		const call = { options, closed: false, delivered: [] };
		queries.push(call);
		return {
			async *[Symbol.asyncIterator]() {
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
const registered = {};
const tools = {};
await extension({
	on() {}, registerCommand() {},
	registerTool(tool) { tools[tool.name] = tool; },
	registerProvider(_id, provider) { Object.assign(registered, provider); },
});
const model = { ...registered.models[0], provider: "claude-bridge", api: "claude-bridge" };
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
const fallback = await run([assistant("ONE ANSWER"), success("ONE ANSWER")]);
assert.equal(fallback.content.map((block) => block.text ?? "").join(""), "ONE ANSWER");
console.log("ok   completed assistant + result fallback emits the answer once");

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

const ask = tools.AskClaude;
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
