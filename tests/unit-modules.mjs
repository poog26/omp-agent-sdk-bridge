import test from "node:test";
import assert from "node:assert/strict";

import { authRouteNotice, ccChildEnv } from "../src/child-env.ts";
import { effortFor, planThinking } from "../src/effort.ts";
import { askClaudeToolPolicy, READ_ONLY_TOOLS } from "../src/askclaude-tools.ts";
import { composeAppend, extractOmpPromptParts, isAgentPrompt } from "../src/omp-prompt.ts";
import { convertPiMessages } from "../src/convert.ts";
import { shortPath } from "../src/askclaude-ui.ts";

// --- child env ---

test("subscription billing strips API keys / gateways so the claude.ai login is used", () => {
	const env = ccChildEnv({ billing: "subscription" }, {
		PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "http://gw", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok",
	});
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.ANTHROPIC_BASE_URL, undefined);
	assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tok", "setup-token subscription auth is kept");
	assert.equal(env.PATH, "/bin");
});

test("default billing is inherit: Claude Code's auth methods are never removed unasked", () => {
	const env = ccChildEnv({}, { ANTHROPIC_API_KEY: "sk-x", CLAUDE_CODE_USE_BEDROCK: "1" });
	assert.equal(env.ANTHROPIC_API_KEY, "sk-x");
	assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");
});

test("authRouteNotice names variables that would bypass the Claude login, ignoring Anthropic's own URL", () => {
	assert.equal(authRouteNotice({}), undefined);
	assert.equal(authRouteNotice({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), undefined);
	assert.match(authRouteNotice({ ANTHROPIC_API_KEY: "sk" }), /ANTHROPIC_API_KEY is set/);
	assert.match(authRouteNotice({ ANTHROPIC_BASE_URL: "http://localhost:8080", CLAUDE_CODE_USE_VERTEX: "1" }), /ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_VERTEX are set/);
	assert.doesNotMatch(authRouteNotice({ ANTHROPIC_API_KEY: "sk-secret" }), /sk-secret/, "never echoes values");
});

test("apiKey billing requires a key; inherit leaves auth alone", () => {
	assert.throws(() => ccChildEnv({ billing: "apiKey" }, {}), /ANTHROPIC_API_KEY is not set/);
	assert.equal(ccChildEnv({ billing: "apiKey" }, { ANTHROPIC_API_KEY: "sk" }).ANTHROPIC_API_KEY, "sk");
	assert.equal(ccChildEnv({ billing: "inherit" }, { ANTHROPIC_BASE_URL: "http://gw" }).ANTHROPIC_BASE_URL, "http://gw");
});

test("guards always win, the client app is named, parent CC session markers are dropped", () => {
	const env = ccChildEnv({ clientApp: "omp-agent-sdk-bridge/1.0.0" }, {
		DISABLE_AUTO_COMPACT: "0", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "abc",
	});
	assert.equal(env.DISABLE_AUTO_COMPACT, "1");
	assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
	assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
	assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, "omp-agent-sdk-bridge/1.0.0");
	assert.equal(env.CLAUDECODE, undefined);
	assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined, "the SDK stamps its own entrypoint");
	assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
});

test("tool input streams as Claude writes it unless the user opted out", () => {
	assert.equal(ccChildEnv({}, {}).CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING, "1");
	assert.equal(ccChildEnv({}, { CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "0" }).CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING, "0");
});

// Compliance rule (see AGENTS.md): the bridge configures Claude Code only through
// interfaces Anthropic documents. Every variable it sets must be on this list, each
// checked against code.claude.com/docs/en/env-vars or the Agent SDK's own docs.
const DOCUMENTED_CHILD_ENV = new Set([
	"ENABLE_CLAUDEAI_MCP_SERVERS", "DISABLE_AUTO_COMPACT", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
	"CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS", "CLAUDE_AGENT_SDK_CLIENT_APP",
	"CLAUDE_CODE_PROMPT_CACHE_TTL", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL", "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
]);

test("the bridge sets only Claude Code variables that Anthropic documents", () => {
	for (const billing of ["inherit", "subscription", "apiKey"]) {
		const env = ccChildEnv({ billing, clientApp: "omp-agent-sdk-bridge/1.0.0" }, billing === "apiKey" ? { ANTHROPIC_API_KEY: "sk" } : {});
		const added = Object.keys(env).filter((k) => k !== "ANTHROPIC_API_KEY");
		assert.deepEqual(added.filter((k) => !DOCUMENTED_CHILD_ENV.has(k)), [], billing);
	}
});

test("building the child env never mutates the parent env", () => {
	const parent = { ANTHROPIC_API_KEY: "sk" };
	ccChildEnv({}, parent);
	assert.deepEqual(parent, { ANTHROPIC_API_KEY: "sk" });
	assert.equal(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
});

// --- thinking / effort ---

const adaptive = { thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] } };
const sonnet46 = { thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high"] } };
const haiku45 = { thinking: { mode: "budget", efforts: ["minimal", "low", "medium", "high", "xhigh"] } };

test("effort maps OMP levels and clamps to what the model supports", () => {
	assert.equal(effortFor(adaptive, "minimal"), "low");
	assert.equal(effortFor(adaptive, "xhigh"), "xhigh");
	assert.equal(effortFor(adaptive, "max"), "max");
	assert.equal(effortFor(sonnet46, "xhigh"), "high");
	assert.equal(effortFor(sonnet46, "max"), "high");
	assert.equal(effortFor(haiku45, "high"), undefined, "budget-mode models keep Claude Code's default");
	assert.equal(effortFor(adaptive, undefined), undefined);
});

test("thinking off is an explicit disable, not just 'no effort'", () => {
	assert.deepEqual(planThinking(adaptive, { disableReasoning: true, reasoning: "high" }), { disabled: true });
	assert.deepEqual(planThinking(adaptive, { forceReasoningOff: true }), { disabled: true });
	assert.deepEqual(planThinking(adaptive, { reasoning: "high" }), { effort: "high", display: "summarized" });
	assert.deepEqual(planThinking(adaptive, { reasoning: "high", hideThinkingSummary: true }), { effort: "high", display: "omitted" });
});

// --- AskClaude tool policy ---

test("AskClaude read mode is an allowlist with no command execution and no bypass", () => {
	const p = askClaudeToolPolicy("read");
	assert.deepEqual(p.tools, READ_ONLY_TOOLS);
	for (const t of ["Bash", "PowerShell", "Monitor", "Write", "Edit", "NotebookEdit", "Agent"]) assert.ok(!p.tools.includes(t), t);
	assert.equal(p.permissionMode, "dontAsk");
	assert.deepEqual(askClaudeToolPolicy("none").tools, []);
	const full = askClaudeToolPolicy("full");
	assert.equal(full.permissionMode, "bypassPermissions");
	assert.ok(full.disallowedTools.includes("AskUserQuestion"));
});

// --- OMP prompt projection (synthetic; the real renderer is covered by tests/contract-omp-prompt.ts) ---

const block0 = [
	"RFC 2119 keywords...", "", "§ Role", "You are omp's trusted coding assistant.", "",
	"# Personality", "You are Daisy.", "## Examples", "“Oh… hi, love.”", "",
	"§ Runtime", "# Skills & Rules", "Matching skill → MUST read `skill://<name>` first.", "<skills>", "- demo: Demo", "</skills>", "",
	"# Internal URLs", "- `skill://<name>`: instructions", "", "§ Tool Policy", "harness stuff",
].join("\n");
const block1 = [
	"<project-context>", "<workstation>", "- OS: win32", "</workstation>",
	"<repo-rules>", '<file path="C:/Users/me/.omp/agent/AGENTS.md">', "Use ~/.omp/agent/PERSONALITY.md and run omp plugin list.", "</file>", "</repo-rules>",
	"</project-context>", "", "<critical>", "- harness critical", "</critical>", "", "APPEND TEXT",
].join("\n");

test("extracts persona, skills, project context and append text; leaves harness sections out", () => {
	const parts = extractOmpPromptParts([block0, block1]);
	assert.match(parts.personality, /^# Personality\nYou are Daisy\.\n## Examples/);
	assert.doesNotMatch(parts.personality, /§ Runtime/);
	assert.match(parts.skillsAndRules, /<skills>\n- demo: Demo\n<\/skills>/);
	assert.doesNotMatch(parts.skillsAndRules, /Internal URLs/);
	assert.match(parts.projectContext, /^<project-context>[\s\S]*<\/project-context>$/);
	assert.equal(parts.appendText, "APPEND TEXT");

	const append = composeAppend(parts);
	assert.doesNotMatch(append, /trusted coding assistant|harness stuff|harness critical/);
	assert.match(append, /mcp__custom-tools__read/, "skill:// reading is pointed at the bridged read tool");
});

test("user content is forwarded verbatim: no renaming of omp paths or words", () => {
	const append = composeAppend(extractOmpPromptParts([block0, block1]));
	assert.match(append, /~\/\.omp\/agent\/PERSONALITY\.md/);
	assert.match(append, /run omp plugin list/);
	assert.doesNotMatch(append, /environment plugin list|~\/\.claude\/agent/);
});

test("projection switches and agent-prompt detection", () => {
	const parts = extractOmpPromptParts([block0, block1]);
	assert.doesNotMatch(composeAppend(parts, { personality: false }), /Daisy/);
	assert.equal(composeAppend({}), undefined);
	assert.ok(isAgentPrompt([block0, block1]));
	assert.ok(!isAgentPrompt(["You are a summarizer."]));
});

// --- message conversion ---

test("OMP developer messages reach Claude as user text", () => {
	const { anthropicMessages } = convertPiMessages([
		{ role: "user", content: "hi", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 },
		{ role: "developer", content: "Continue.", timestamp: 3 },
	]);
	assert.deepEqual(anthropicMessages.at(-1), { role: "user", content: "Continue." });
});

// --- UI helpers ---

test("shortPath shortens Windows and POSIX paths", () => {
	assert.equal(shortPath("C:\\proj\\src\\a.ts", "C:\\proj"), "src/a.ts");
	assert.equal(shortPath("/home/me/proj/src/a.ts", "/home/me/proj"), "src/a.ts");
	assert.equal(shortPath("D:\\x\\y\\z\\w.ts", "C:\\proj"), "z/w.ts");
});

// --- stable mirror ids ---

import { mirrorIdFor } from "../src/session-id.ts";

test("mirror ids are stable per OMP session, distinct across sessions, and UUID-shaped", () => {
	const a = mirrorIdFor("01a19bba-ebc0-7660-9e71-2c90eadad93e");
	assert.equal(a, mirrorIdFor("01a19bba-ebc0-7660-9e71-2c90eadad93e"));
	assert.notEqual(a, mirrorIdFor("another-session"));
	assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// --- OMP persona as Claude Code output style ---

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { ensurePersonaStyle, personaBody } from "../src/persona-style.ts";

test("persona style: plugin + style file written, selected as plugin:name, coding instructions kept", () => {
	const root = mkdtempSync(joinPath(tmpdir(), "ocb-persona-"));
	try {
		const style = ensurePersonaStyle("# Personality\nYou are Daisy.\n## Examples\n“Oh… hi, love.”", root);
		assert.match(style.outputStyle, /^omp-bridge:OMP Persona [0-9a-f]{10}$/);
		assert.equal(JSON.parse(readFileSync(joinPath(root, ".claude-plugin", "plugin.json"), "utf-8")).name, "omp-bridge");
		const files = readdirSync(joinPath(root, "output-styles"));
		assert.equal(files.length, 1);
		const content = readFileSync(joinPath(root, "output-styles", files[0]), "utf-8");
		assert.match(content, /keep-coding-instructions: true/);
		assert.match(content, /\nYou are Daisy\.\n## Examples\n/);
		assert.doesNotMatch(content, /# Personality/, "OMP's heading is dropped");
		// Same persona -> same style, no new file; different persona -> its own file.
		assert.equal(ensurePersonaStyle("# Personality\nYou are Daisy.\n## Examples\n“Oh… hi, love.”", root).outputStyle, style.outputStyle);
		assert.notEqual(ensurePersonaStyle("# Personality\nSomeone else.", root).outputStyle, style.outputStyle);
		assert.equal(readdirSync(joinPath(root, "output-styles")).length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("persona style: empty personality yields nothing", () => {
	assert.equal(personaBody("# Personality\n   \n"), "");
	assert.equal(ensurePersonaStyle("# Personality\n", "unused"), undefined);
});

test("prompt cache TTL defaults to 5m for both buckets, can be 1h, or left to Claude Code", () => {
	const def = ccChildEnv({}, {});
	assert.equal(def.CLAUDE_CODE_PROMPT_CACHE_TTL, "5m");
	assert.equal(def.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, "5m");
	assert.equal(ccChildEnv({ promptCacheTtl: "1h" }, {}).CLAUDE_CODE_PROMPT_CACHE_TTL, "1h");
	const left = ccChildEnv({ promptCacheTtl: "default" }, { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" });
	assert.equal(left.CLAUDE_CODE_PROMPT_CACHE_TTL, "1h", "the user's own setting is left alone");
	assert.equal(ccChildEnv({ promptCacheTtl: "default" }, {}).CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, undefined);
});
