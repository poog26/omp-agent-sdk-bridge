import { StringEnum, Type, calculateCost, getModels, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool, type Usage } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import * as piAi from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import { type ExtensionAPI, type ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { createSdkMcpServer, query, type SDKMessage, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { Text } from "@oh-my-pi/pi-tui";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { createSession, deleteSession, repairToolPairing } from "cc-session-io";
import { extendCleanSession as _extendCleanSession, sessionFileBytes, sessionPath } from "./session-extend.js";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { buildVariantModels, buildModels, claudeCodeModelId, parseVariantId, type LongContextSettings, resolveModel as _resolveModel } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { mirrorIdFor } from "./session-id.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx } from "./query-state.js";
import { makePromptStream, userMessage } from "./prompt-stream.js";
import { loadConfig, type Config, type ForwardSettings } from "./config.js";
import { composeAppend, extractOmpPromptParts, isAgentPrompt } from "./omp-prompt.js";
import { ensurePersonaStyle, type PersonaStyle } from "./persona-style.js";
import { authRouteNotice, ccChildEnv, promptCacheSeconds } from "./child-env.js";
import { planThinking, type ThinkingPlan } from "./effort.js";
import { askClaudeToolPolicy, type AskClaudeMode } from "./askclaude-tools.js";
import { jsonSchemaToZodSchema } from "./typebox-to-zod.js";
import { applyClaudeUsage, type UsageTarget } from "./usage.js";
import { subscriptionWarmingAction } from "./cache-warming.js";
import { buildUsageReport, loadUsageState, recordAccount, recordRateLimit, saveUsageState } from "./usage-report.js";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import { explainClaudeError, isExtraUsage, newRateLimitTracker, rateLimitNotice, type RateLimitInfo } from "./rate-limit.js";
import { QueryMeter, appendLedger, detectMiss, formatReport, formatTokens, promptTokens, readLedger, summarizeLedger, tokensFromReport, type Fingerprint, type LedgerEntry, type PrevCall, type SyncPath } from "./usage-ledger.js";

// Compat (#2): use factory if available (pi-ai ≥0.66), else fall back to constructor (gsd-pi etc.)
const _piAi = piAi as any;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.omp/agent/claude-bridge.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(getAgentDir(), "claude-bridge.log");
const DIAG_LOG_PATH = join(getAgentDir(), "claude-bridge-diag.log");

// Name + version for CLAUDE_AGENT_SDK_CLIENT_APP, so Claude Code's User-Agent says
// which app is driving it.
const BRIDGE_VERSION = (() => {
	try {
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		return String(JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "dev");
	} catch {
		return "dev";
	}
})();
const CLIENT_APP = `omp-agent-sdk-bridge/${BRIDGE_VERSION}`;
const ISSUES_URL = "https://github.com/poog26/omp-agent-sdk-bridge/issues";

// Ensure log directories exist when debug is enabled
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
}

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	// Diagnostics must never take a turn down with them.
	try {
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
		appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	} catch { /* ignore */ }
	debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// --- Constants ---

// Global key to prevent re-registration of the provider across module reloads.
//
// Extensions like OMP subagents spawn a subagent and it loads this module
// again. Without this guard, the subagent's call to registerProvider() would
// overwrite the parent's `streamSimple` function reference in the shared
// ModelRegistry. When the parent later delivers a tool result, it would call
// the subagent's `streamSimple` (which has empty state) instead of its own.
//
// By storing the active streamSimple in a Symbol.for() global (shared across all
// module instances), we ensure only the FIRST instance to register takes effect.
// Subsequent instances wrap the stored function instead of overwriting it.
//
// On session_shutdown (including /reload), clearSession() resets this so a fresh
// registration can occur for the next session.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

// Base (unsuffixed) models projected from OMP's Anthropic catalog; set at registration
// once the exclude list is known.
let MODELS = buildModels(getModels("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false, contextWindow: "auto" };
const rateLimitTracker = newRateLimitTracker();

function resolveModel(input: string) {
	return _resolveModel(MODELS, input);
}

/** Catalog window for a registered (possibly "-1m"/"-200k") id; drives the 1M offer for unmeasured models. */
function catalogWindow(registeredId: string): number | undefined {
	const { baseId } = parseVariantId(registeredId);
	return MODELS.find((m) => m.id === baseId)?.contextWindow;
}

function cliModelFor(model: { id: string }): string {
	return claudeCodeModelId(model, longContextSettings, catalogWindow(model.id));
}

function childEnv(): NodeJS.ProcessEnv {
	return ccChildEnv({ billing: providerSettings.billing, clientApp: CLIENT_APP, promptCacheTtl: providerSettings.promptCacheTtl });
}

// Claude Code settings applied to every bridge-spawned process (flag tier, so they
// override ~/.claude/settings.json).
//   claudeMdExcludes: OMP already forwards its own context files; Claude Code loading
//     CLAUDE.md/AGENTS.md as well would duplicate them, and ~/.claude/CLAUDE.md is a
//     persona written for a different harness.
//   disableAllHooks: hooks in ~/.claude/settings.json are written for interactive
//     Claude Code (notifications, memory capture); OMP owns its own.
//   outputStyle: OMP owns persona; a Claude Code output style would stack on top.
//   includeGitInstructions: false keeps a git-status snapshot out of the cached
//     system block, so commits and staging don't bust the prompt cache.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];
function claudeSettings(opts: { gitInstructions?: boolean; outputStyle?: string } = {}) {
	return {
		claudeMdExcludes: CLAUDE_MD_EXCLUDES,
		autoMemoryEnabled: providerSettings.autoMemoryEnabled ?? false,
		...(providerSettings.claudeHooks ? {} : { disableAllHooks: true }),
		...(opts.outputStyle ? { outputStyle: opts.outputStyle } : providerSettings.claudeOutputStyle ? {} : { outputStyle: "default" }),
		...(opts.gitInstructions ? {} : { includeGitInstructions: false }),
	};
}

// OMP's personality becomes Claude Code's output style (replacing the preset's
// terminal-tone section) unless the user opted into Claude Code's own style or
// into plain appending. Falls back to appending if the style can't be written.
const PERSONA_PLUGIN_DIR = join(getAgentDir(), "claude-bridge", "persona-plugin");
const USAGE_STATE_PATH = join(getAgentDir(), "claude-bridge", "usage.json");
let accountInfoRequested = false;
function personaStyleFor(personality: string | undefined, forward: ForwardSettings): PersonaStyle | undefined {
	if (!personality || forward.personality === false) return undefined;
	if (providerSettings.claudeOutputStyle || providerSettings.personaAs === "append") return undefined;
	try {
		return ensurePersonaStyle(personality, PERSONA_PLUGIN_DIR);
	} catch (e) {
		debug("persona style: could not write output style, appending persona instead", e);
		return undefined;
	}
}

function thinkingOptions(plan: ThinkingPlan): { effort?: ThinkingPlan["effort"]; thinking?: { type: "disabled" } } {
	if (plan.disabled) return { thinking: { type: "disabled" } };
	return plan.effort ? { effort: plan.effort } : {};
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
	// Byte length of the leading part of CC's JSONL that mirrors OMP's
	// priors[0..cursor) exactly as CC itself wrote it: measured when a query
	// starts, so it stays valid after that query is aborted or fails. A rebuild
	// keeps these bytes verbatim and converts only what follows. Rebuilding
	// from OMP's history alone can't reproduce the records CC adds on its own
	// (resume placeholders, environment/date/output-style attachments), so the
	// rebuilt request diverged right after the system prompt and every cached
	// message had to be written again. Unset after a history rewrite.
	cleanBytes?: number;
	// Set when a query completed: the whole file is clean, including the final
	// assistant message that OMP's next context carries after `cursor`.
	completed?: boolean;
}

// One Claude Code session mirror per OMP session (keyed by the stream options'
// sessionId). A single global mirror let subagents, side requests and the main
// conversation overwrite each other's session and prompt cache.
const sessions = new Map<string, SessionState>();
const DEFAULT_SESSION_KEY = "default";

interface SessionSlot { s: SessionState | null }
function sessionSlot(key: string): SessionSlot {
	return {
		get s() { return sessions.get(key) ?? null; },
		set s(v: SessionState | null) { if (v) sessions.set(key, v); else sessions.delete(key); },
	};
}

// Convert pi messages to Anthropic API format for session import.
// Lossy: non-Anthropic thinking blocks are dropped (no valid signature), and only
// text/image/toolCall block types are handled. If all blocks in an assistant message
// are filtered, the message is dropped — which can create invalid sequences (e.g.
// two user messages in a row, or tool_result without preceding tool_use).
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
): void {
	const { anthropicMessages, sanitizedIds } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	if (repaired.length) session.importMessages(repaired);
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Extract the last user message from context as a prompt string. Returns null if last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || (last.role !== "user" && last.role !== "developer")) return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

/** Extract the last user message as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const last = messages[messages.length - 1];
	if (!last || (last.role !== "user" && last.role !== "developer")) return null;
	if (typeof last.content === "string") {
		debug(`extractUserPromptBlocks: content is string (length=${last.content.length})`);
		return null;
	}
	if (!Array.isArray(last.content)) {
		debug(`extractUserPromptBlocks: content is ${typeof last.content}`);
		return null;
	}
	debug(`extractUserPromptBlocks: ${last.content.length} blocks, types=${last.content.map((b: any) => b.type).join(",")}`);
	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const block of last.content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			debug(`image block: mimeType=${(block as any).mimeType}, data length=${((block as any).data ?? "").length}, keys=${Object.keys(block).join(",")}`);
			if (!(block as any).data || !(block as any).mimeType) {
				debug(`image block missing data or mimeType, skipping`);
				continue;
			}
			hasImage = true;
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
			});
		}
	}
	return hasImage ? blocks : null;
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function systemPromptText(systemPrompt: Context["systemPrompt"] | string | undefined): string | undefined {
	if (!systemPrompt) return undefined;
	return Array.isArray(systemPrompt) ? systemPrompt.join("\n\n") : systemPrompt;
}


// --- One-shot calls (compaction, titles, recaps, handoffs, /btw) ---
//
// OMP makes tool-less side calls through the active model: compaction summaries
// (same sessionId as the live conversation), titles, idle recaps, handoffs. They
// must never touch the conversation's Claude Code session, so they run as an
// isolated, non-persisted, single-turn Claude Code query with OMP's own system
// prompt for that call. Routing them here replaces the old session_before_compact
// takeover, which raced OMP's extension-handler timeout.

/** True for calls that are not a turn of the main agent loop. */
function isOneShotCall(context: Context): boolean {
	return !context.tools?.length || !isAgentPrompt(context.systemPrompt);
}

/** The whole transcript as one prompt: the last user turn verbatim, earlier turns labelled. */
function oneShotPrompt(messages: Context["messages"]): string {
	const text = (m: Context["messages"][number]): string => {
		if (m.role === "assistant") {
			return (Array.isArray(m.content) ? m.content : [])
				.map((b: any) => b.type === "text" ? b.text : b.type === "toolCall" ? `[tool call ${b.name} ${JSON.stringify(b.arguments ?? {})}]` : "")
				.filter(Boolean).join("\n");
		}
		const content = (m as { content?: unknown }).content;
		return typeof content === "string" ? content : messageContentToText(content as any);
	};
	if (messages.length === 1) return text(messages[0]);
	const label: Record<string, string> = { user: "User", developer: "System note", assistant: "Assistant", toolResult: "Tool result" };
	return messages.map((m) => `## ${label[m.role] ?? m.role}\n${text(m)}`).join("\n\n");
}

function resultErrorText(message: SDKMessage): string {
	const result = message as SDKMessage & { subtype?: string; errors?: unknown; error?: unknown; result?: unknown };
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	if (typeof result.result === "string" && result.result) return result.result;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

/** Claude Code flags failures with is_error on a result whose subtype may still be "success". */
function isErrorResult(message: SDKMessage): boolean {
	const r = message as SDKMessage & { subtype?: string; is_error?: boolean };
	return r.subtype !== "success" || r.is_error === true;
}

// --- Prompt-cache warming ---
//
// OMP's cache warmer (providers.cacheWarming) keeps a prompt-cache entry alive by
// re-sending the last request with maxTokens 1 shortly before the entry expires.
// Re-sent to the bridge as-is, it would be a new turn that writes into the session.
// The bridge answers it with a side request that leaves nothing behind: a fork of
// the session that is never saved (forkSession + persistSession: false), built with
// the same model, prompt, tools and settings so it reads, and so refreshes, the
// cached prefix. It is cut off as soon as the usage arrives. OMP decides whether a
// refresh is worth sending and stops after its own safety windows.

interface WarmRecipe {
	/** The last message of the request the entry belongs to; a replay carries the same one. */
	lastMessage: unknown;
	mcpTools: Tool[];
	options: NonNullable<Parameters<typeof query>[0]["options"]>;
}

const warmRecipes = new Map<string, WarmRecipe>();
const WARM_PROMPT = "Prompt-cache refresh sent automatically by the OMP bridge. No reply is needed.";

function isWarmReplay(context: Context, options: SimpleStreamOptions | undefined, sessionKey: string): boolean {
	if (options?.maxTokens !== 1) return false;
	const recipe = warmRecipes.get(sessionKey);
	return recipe !== undefined && recipe.lastMessage === context.messages[context.messages.length - 1];
}

function cacheWarmStream(model: Model<any>, sessionKey: string, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	void runCacheWarm(model, sessionKey, options, stream);
	return stream;
}

async function runCacheWarm(
	model: Model<any>,
	sessionKey: string,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const recipe = warmRecipes.get(sessionKey);
	const sessionId = sessionSlot(sessionKey).s?.sessionId;
	const output = newAssistantOutput(model, "", "stop");
	let sdkQuery: ReturnType<typeof query> | undefined;
	const onAbort = () => { try { sdkQuery?.close(); } catch {} };
	try {
		if (!recipe || !sessionId) throw new Error("claude-bridge: nothing to keep warm");
		const { extraArgs = {}, ...base } = recipe.options;
		const { "replay-user-messages": _replay, ...warmArgs } = extraArgs;
		const mcpServers = buildMcpServers(recipe.mcpTools, new QueryContext());
		sdkQuery = query({
			prompt: WARM_PROMPT,
			options: {
				...base,
				extraArgs: warmArgs,
				...(mcpServers ? { mcpServers } : {}),
				resume: sessionId,
				forkSession: true,
				persistSession: false,
				maxTurns: 1,
				includePartialMessages: true,
				...makeCliDebugOptions("cache-warm"),
			},
		});
		if (options?.signal?.aborted) onAbort();
		else options?.signal?.addEventListener("abort", onAbort, { once: true });
		for await (const message of sdkQuery) {
			if (message.type === "stream_event" && message.event.type === "message_start") {
				updateUsage(output, message.event.message.usage as unknown as Record<string, unknown>, model);
				recordCall({ ts: Date.now(), kind: "warm", model: model.id, session: sessionKey.slice(-8), ...tokensFromReport(message.event.message.usage) }, sessionKey);
				// OMP counts a refresh as landing on the entry only when it writes nothing,
				// which its own byte-identical replays do. This one appends the short refresh
				// message, which Claude Code caches too. When that tail is all it wrote, its
				// tokens are reported as input; the cost already priced them as a cache write
				// and stays exact. A real prefix re-write still reports as the miss it is.
				const { cacheRead, cacheWrite } = output.usage;
				if (cacheWrite > 0 && cacheRead > 0 && cacheWrite <= Math.max(1024, cacheRead * 0.02)) {
					output.usage.input += cacheWrite;
					output.usage.cacheWrite = 0;
					delete (output.usage as UsageTarget).cttl;
				}
				break;
			}
			if (message.type === "result") break;
		}
		debug(`cache-warm: session=${sessionId.slice(0, 8)} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite}`);
		stream.push({ type: "start", partial: output });
		stream.push({ type: "done", reason: "stop", message: output });
	} catch (e) {
		const aborted = Boolean(options?.signal?.aborted);
		debug(`cache-warm: ${aborted ? "aborted" : "failed"}:`, e);
		output.stopReason = aborted ? "aborted" : "error";
		output.errorMessage = aborted ? "Operation aborted" : errorMessage(e);
		stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
		markStreamComplete(stream);
		stream.end();
	}
}

function oneShotStream(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	void runOneShot(model, context, options, stream);
	return stream;
}

async function runOneShot(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = oneShotPrompt(context.messages);
		if (!promptText.trim()) throw new Error("claude-bridge: one-shot call has an empty prompt");
		const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const cliModel = cliModelFor(model);
		const thinking = planThinking(model as any, options ?? {});
		const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
		const extraArgs: Record<string, string | null> = {};
		if (thinking.display) extraArgs["thinking-display"] = thinking.display;
		debug(`one-shot: spawn model=${cliModel} registered=${model.id} msgs=${context.messages.length} effort=${thinking.effort ?? (thinking.disabled ? "off" : "default")} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: childEnv(),
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				settings: claudeSettings(),
				skills: [],
				persistSession: false,
				// OMP's own system prompt for this call (e.g. the summarizer's), not the preset.
				systemPrompt: systemPromptText(context.systemPrompt) ?? "",
				model: cliModel,
				maxTurns: 1,
				...thinkingOptions(thinking),
				...(Object.keys(extraArgs).length ? { extraArgs } : {}),
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("one-shot"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		// The call's usage: priced onto the result so OMP's stats count compaction and titles too.
		let resultUsage: Record<string, unknown> | undefined;
		const startedAt = Date.now();

		for await (const message of sdkQuery) {
			if (wasAborted) break;
			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("one-shot", message, model);
				if (isErrorResult(message)) errorText = resultErrorText(message);
				else finalText = (message as any).result || assistantText;
				resultUsage = message.usage as unknown as Record<string, unknown>;
				if (resultUsage) recordCall({ ts: startedAt, kind: "one-shot", model: model.id, ...tokensFromReport(resultUsage) });
			} else if (message.type === "rate_limit_event") {
				reportRateLimit((message as any).rate_limit_info);
			}
		}

		if (wasAborted) {
			stream.push({ type: "error", reason: "aborted", error: newAssistantOutput(model, "", "aborted", "Operation aborted") });
			stream.end();
			return;
		}
		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = explainClaudeError(errorText ?? "Claude Code returned empty text");
			debug(`one-shot: error ${msg}`);
			const failed = newAssistantOutput(model, "", "error", msg);
			if (resultUsage) updateUsage(failed, resultUsage, model);
			stream.push({ type: "error", reason: "error", error: failed });
			stream.end();
			return;
		}
		debug(`one-shot: done textLen=${text.length}`);
		const done = newAssistantOutput(model, text, "stop");
		if (resultUsage) updateUsage(done, resultUsage, model);
		stream.push({ type: "done", reason: "stop", message: done });
		stream.end();
	} catch (err) {
		const msg = explainClaudeError(errorMessage(err));
		debug("one-shot threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

/** Surface a rate-limit event. Returns true when the request is being billed to Extra Usage. */
function reportRateLimit(info: RateLimitInfo | undefined): boolean {
	if (!info) return false;
	debug("rate_limit_event", JSON.stringify(info).slice(0, 300));
	const state = loadUsageState(USAGE_STATE_PATH);
	if (recordRateLimit(state, info)) saveUsageState(USAGE_STATE_PATH, state);
	const notice = rateLimitNotice(info, rateLimitTracker);
	if (notice) piUI?.notify(notice.message, notice.level === "info" ? "info" : notice.level === "error" ? "error" : "warning");
	return isExtraUsage(info);
}

// --- Usage ledger (usage-ledger.ts) ---
//
// Every request Claude Code makes for the bridge is written to the ledger. Conversation
// requests are checked against the previous one of the same OMP session, so a cache
// miss inside the cache lifetime is caught with its likeliest cause.

const LEDGER_PATH = join(getAgentDir(), "claude-bridge", "usage-ledger.jsonl");
// The last request per OMP session, for spotting cache misses.
const lastCalls = new Map<string, PrevCall>();
// Sessions whose history OMP rewrote (compaction, /tree) since their last request.
const rewrittenSessions = new Set<string>();
// This process's conversation figures, for the footer status.
const statusTotals = { prompt: 0, cacheRead: 0, misses: 0, lost: 0, unseen: 0 };
// Misses this large are worth interrupting for; smaller ones only go to the ledger.
const MISS_NOTIFY_TOKENS = 20_000;

/** What makes up a turn's cached prefix, hashed, so a miss can be traced to what changed. */
function callFingerprint(system: unknown, tools: Tool[], thinking: unknown): Fingerprint {
	const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex").slice(0, 12);
	return {
		system: hash(system),
		tools: hash(tools.map((t) => [t.name, t.description, t.parameters])),
		thinking: hash(thinking),
	};
}

/** Ledger one request; with a session key, check it for a cache miss and surface waste. */
function recordCall(entry: LedgerEntry, sessionKey?: string, fingerprint?: Fingerprint): void {
	if (sessionKey !== undefined) {
		const prev = lastCalls.get(sessionKey);
		// "default" leaves the lifetime to Claude Code, which uses 1h on a plan.
		const ttl = promptCacheSeconds(providerSettings.promptCacheTtl) ?? 3600;
		const historyRewritten = entry.kind === "turn" && rewrittenSessions.delete(sessionKey);
		const miss = detectMiss(prev, { startedAt: entry.ts, model: entry.model, tokens: entry, sync: entry.sync, fingerprint, historyRewritten }, ttl);
		if (miss) entry.miss = miss;
		// A refresh keeps the previous prefix alive; it doesn't replace it.
		lastCalls.set(sessionKey, entry.kind === "warm" && prev
			? { ...prev, endedAt: Date.now() }
			: { endedAt: Date.now(), prompt: promptTokens(entry), model: entry.model, fingerprint });
	}
	appendLedger(LEDGER_PATH, entry);

	if (entry.kind === "turn") {
		statusTotals.prompt += promptTokens(entry);
		statusTotals.cacheRead += entry.cacheRead;
	}
	if (entry.miss && !entry.miss.expected) {
		statusTotals.misses++;
		statusTotals.lost += entry.miss.lost;
		debug(`cache miss: ${entry.kind} ${entry.model} lost=${entry.miss.lost} sync=${entry.sync ?? "-"} cause=${entry.miss.cause}`);
		if (entry.miss.lost >= MISS_NOTIFY_TOKENS) {
			piUI?.notify(`Claude bridge: cache miss, ${formatTokens(entry.miss.lost)} tokens written again (${entry.miss.cause}). /claude-usage for details.`, "warning");
		}
	}
	if (entry.kind === "unattributed") {
		const unseen = promptTokens(entry) + entry.output;
		statusTotals.unseen += unseen;
		debug(`unattributed usage: ${JSON.stringify(entry)}`);
		piUI?.notify(`Claude bridge: Claude Code used ${formatTokens(unseen)} tokens in requests the bridge never saw. /claude-usage for details.`, "warning");
	}
	if (statusTotals.prompt > 0) {
		const parts = [`Claude cache ${Math.round((statusTotals.cacheRead / statusTotals.prompt) * 100)}%`];
		if (statusTotals.misses) parts.push(`${statusTotals.misses} miss${statusTotals.misses === 1 ? "" : "es"} (${formatTokens(statusTotals.lost)})`);
		if (statusTotals.unseen) parts.push(`${formatTokens(statusTotals.unseen)} unseen`);
		piUI?.setStatus("claude-bridge", parts.join(" · "));
	}
}

interface SyncResult {
	sessionId: string | null;
	/** How the session was prepared, for the ledger. */
	path: SyncPath;
	preserveSharedSession?: boolean;
	/** Clean start: the stable id Claude Code should give the new session. */
	freshSessionId?: string;
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please report it at ${ISSUES_URL}` +
			(DEBUG ? ` and attach ${DEBUG_LOG_PATH}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
	key: string = DEFAULT_SESSION_KEY,
): SyncResult {
	const slot = sessionSlot(key);
	const priorMessages = messages.slice(0, -1); // everything before the new user prompt

	// REUSE path
	//
	// Guard on priorMessages.length >= cursor: a shorter incoming context cannot
	// be a continuation of the cached session. This is the general invariant for
	// pi-side history rewrites such as /compact and session_tree: without it,
	// missed = [].slice(cursor) can falsely hit REUSE and resume an unrelated
	// longer CC session. See issue #25.
	if (slot.s && !slot.s.needsRebuild && priorMessages.length >= slot.s.cursor) {
		const missed = priorMessages.slice(slot.s.cursor);
		const trailingAssistantOnly =
			missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
			slot.s = {
				...slot.s, cursor: priorMessages.length, cwd,
				cleanBytes: sessionFileBytes(slot.s.sessionId, cwd), completed: false,
			};
			debug(`Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${slot.s.sessionId.slice(0, 8)}, cursor=${slot.s.cursor}`);
			debug(`syncResult: path=reuse sessionId=${slot.s.sessionId} cursor=${slot.s.cursor}`);
			return { sessionId: slot.s.sessionId, path: "reuse" };
		}
	}
	// Only reachable when needsRebuild is false — user-facing history rewrites
	// (/compact, session_tree, /new, fork) always set needsRebuild or clear
	// slot.s before the next syncSharedSession call. In practice this
	// fires only for isolated compact-summary subprocesses.
	if (slot.s && !slot.s.needsRebuild && priorMessages.length < slot.s.cursor) {
		debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${slot.s.sessionId.slice(0, 8)}, cursor=${slot.s.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${slot.s.sessionId} cursor=${slot.s.cursor}`);
		return { sessionId: null, path: "clean-start", preserveSharedSession: true };
	}

	// EXTEND path: OMP's history before `cursor` is unchanged (no compaction or
	// tree move), so keep CC's own records for it and convert only the rest.
	if (slot.s && priorMessages.length >= slot.s.cursor) {
		const extended = extendCleanSession(slot, priorMessages, cwd, customToolNameToSdk);
		if (extended) return extended;
	}

	// REBUILD path
	const stableId = key === DEFAULT_SESSION_KEY ? undefined : mirrorIdFor(key);
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${messages.length} total messages`);
		debug(`syncResult: path=clean-start${stableId ? ` stableId=${stableId.slice(0, 8)}` : ""}`);
		return { sessionId: null, path: "clean-start", freshSessionId: slot.s?.forceRotate ? undefined : stableId };
	}
	const previousSessionId = slot.s?.sessionId;
	const previousCursor = slot.s?.cursor ?? 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs above.
	const preserveId = previousSessionId !== undefined && !slot.s?.forceRotate;
	// No mirror yet in this process (e.g. OMP restarted): reuse the OMP session's
	// stable id, overwriting its old mirror rather than adding another file.
	const targetId = preserveId ? previousSessionId : slot.s?.forceRotate ? undefined : stableId;
	if (targetId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(targetId, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(targetId ? { sessionId: targetId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk);
	session.save();
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd);
	slot.s = { sessionId: session.sessionId, cursor: priorMessages.length, cwd, cleanBytes: sessionFileBytes(session.sessionId, cwd) };
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.messages.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId, path: "rebuild" };
}

/** EXTEND path wrapper: see session-extend.ts. Falls back to a rebuild on any failure. */
function extendCleanSession(
	slot: { s: SessionState | null },
	priorMessages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
): SyncResult | undefined {
	const state = slot.s;
	if (!state) return undefined;
	try {
		const result = _extendCleanSession(state, priorMessages, cwd, (session, tail) => convertAndImportMessages(session, tail, customToolNameToSdk));
		if (!result) return undefined;
		verifyWrittenSession(sessionPath(result.sessionId, cwd), result.sessionId, result.totalRecords, cwd);
		slot.s = { sessionId: result.sessionId, cursor: priorMessages.length, cwd, cleanBytes: result.cleanBytes };
		debug(`syncResult: path=extend sessionId=${result.sessionId.slice(0, 8)} kept=${result.keptRecords} records, converted ${result.convertedMessages} msgs${result.sessionId !== state.sessionId ? ` (rotated from ${state.sessionId.slice(0, 8)})` : ""}`);
		return { sessionId: result.sessionId, path: "extend" };
	} catch (e) {
		debug(`extendCleanSession failed, falling back to a full rebuild:`, e);
		return undefined;
	}
}

// @internal
export const __test = {
	resetSharedSession(key: string = DEFAULT_SESSION_KEY) {
		sessions.delete(key);
	},
	setSharedSession(state: SessionState | null, key: string = DEFAULT_SESSION_KEY) {
		sessionSlot(key).s = state;
	},
	getSharedSession(key: string = DEFAULT_SESSION_KEY) {
		return sessions.get(key) ?? null;
	},
	syncSharedSession,
};

// --- Provider helpers: tool name mapping ---

function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// No injected bash timeout: OMP 18's bash applies its own default, and a value
	// written into the stored args made every rebuilt session miss the prompt cache.
	return result;
}

// --- Provider helpers: tool resolution ---

// --- Provider helpers: tool bridge ---

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
let piUI: ExtensionUIContext | null = null;
const activeQueryContexts = new Set<QueryContext>();

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers are assigned toolCallIds from turnToolCallIds (populated when the SDK
// emits tool_use blocks). Results are matched by ID, not position.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: jsonSchemaToZodSchema(tool.parameters),
		handler: async () => {
			const toolCallId = queryCtx.turnToolCallIds[queryCtx.nextHandlerIdx++];
			if (!toolCallId) debug(`WARNING: mcp handler ${tool.name} has no toolCallId (idx=${queryCtx.nextHandlerIdx - 1}, available=${queryCtx.turnToolCallIds.length})`);
			if (toolCallId && queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
	return { [MCP_SERVER_NAME]: server };
}

// --- Usage helpers ---

// Prices with OMP's own calculator (the one every other model's footer uses), so the
// catalog's long-context tiers and cache-write TTLs apply here too.
function updateUsage(output: AssistantMessage, usage: Record<string, unknown>, model: Model<any>): void {
	const reasoning = applyClaudeUsage(output.usage as UsageTarget, usage, model, calculateCost);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current OMP stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

const completedStreams = new WeakSet<object>();

function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const reason = stopReason === "length" ? "length" : "stop";
	const stream = c.currentPiStream;
	stream!.push({ type: "done", reason, message: c.turnOutput });
	markStreamComplete(stream);
	stream!.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to OMP stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		c.turnToolCallIds = [];
		c.nextHandlerIdx = 0;
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: mapToolName(event.content_block.name, customToolNameToPi),
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this OMP stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream!.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	if (c.turnSawStreamEvent) return;
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	c.turnToolCallIds = [];
	c.nextHandlerIdx = 0;
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			const mappedArgs = mapToolArgs(mapToolName(block.name, customToolNameToPi), block.input);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: mapToolName(block.name, customToolNameToPi),
				arguments: mappedArgs,
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
	onExtraUsage: () => void,
	meter: QueryMeter,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		if (wasAborted() || queryCtx.extraUsageBlocked) break;
		// Every request's usage, whether or not an OMP stream is open to show it.
		if (message.type === "stream_event") meter.event(message.event);

		// Handled whether or not an OMP stream is open: after a tool call the stream is
		// closed, and a failure or rate limit arriving then must still be recorded.
		if (message.type === "system") {
			if ((message as any).subtype === "init" && (message as any).session_id) {
				capturedSessionId = (message as any).session_id;
			}
			continue;
		}
		if (message.type === "rate_limit_event") {
			const billedAsExtraUsage = reportRateLimit((message as any).rate_limit_info);
			if (billedAsExtraUsage && !providerSettings.allowExtraUsage) {
				queryCtx.extraUsageBlocked = true;
				onExtraUsage();
				break;
			}
			continue;
		}
		// Claude Code took in a steer: it no longer blocks closing the input.
		if (message.type === "user" && (message as { isReplay?: boolean }).isReplay === true && (message as { uuid?: string }).uuid) {
			queryCtx.pendingSteerUuids.delete((message as { uuid: string }).uuid);
			continue;
		}
		if (message.type === "result") {
			logServedContextWindow("result", message, model);
			// Claude Code's own total for the query, against the requests the bridge saw.
			const unseen = meter.unattributed(message.usage);
			if (unseen) recordCall({ ts: Date.now(), kind: "unattributed", model: model.id, ...unseen });
			// A result ends a turn, not necessarily the query: a steer not yet taken in
			// starts another turn. Otherwise close the input so Claude Code exits.
			if (isErrorResult(message) || queryCtx.pendingSteerUuids.size === 0) queryCtx.promptStream?.end();
			if (isErrorResult(message)) {
				queryCtx.resultError = explainClaudeError(resultErrorText(message));
				debug(`consumeQuery: error result: ${queryCtx.resultError}`);
				continue;
			}
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result":
				if (!queryCtx.turnSawStreamEvent) {
					ensureTurnStarted(queryCtx);
					const text = (message as any).result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			case "user":
				break; // SDK echo of user prompt — not needed
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// A request cut off by an abort or error still used the plan.
	meter.close();
	debug(`consumeQuery: loop exited, wasAborted=${wasAborted()}, extraUsageBlocked=${queryCtx.extraUsageBlocked}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);
	return { capturedSessionId };
}

const EXTRA_USAGE_STOP_MESSAGE =
	"Stopped: your Claude plan limit is reached and this request was billed to Extra Usage. " +
	"The bridge stops here so nothing more is charged. Wait for the limit to reset, or set " +
	'"provider.allowExtraUsage": true in claude-bridge.json to continue on Extra Usage.';

/** Messages OMP appended after this turn's tool results (steers), as content blocks. */
function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	let i = messages.length;
	while (i > 0 && (messages[i - 1].role === "user" || messages[i - 1].role === "developer")) i--;
	const blocks: ContentBlockParam[] = [];
	for (const m of messages.slice(i)) {
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string") {
			if (content.trim()) blocks.push({ type: "text", text: content });
			continue;
		}
		for (const block of Array.isArray(content) ? content : []) {
			if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
			else if (block.type === "image" && block.data && block.mimeType) {
				blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data } });
			}
		}
	}
	return blocks.length ? blocks : null;
}

/**
 * Deliver OMP's tool results to the waiting MCP handlers, writing any steer into
 * Claude Code's input first. The order is mandatory: the steer and the tool
 * results reach Claude Code over the same stdin, so the steer must be written
 * before any handler resolves or it misses this tool boundary.
 */
async function deliverToolResults(c: QueryContext, results: McpResult[], steer: ContentBlockParam[] | null): Promise<void> {
	if (steer) {
		const preview = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join(" ").slice(0, 60);
		let delivered = false;
		if (c.promptStream) {
			const uuid = randomUUID();
			c.pendingSteerUuids.add(uuid);
			try {
				await c.promptStream.push({ ...userMessage(steer, "next"), uuid });
				delivered = true;
				debug(`provider: steer written to Claude Code before tool result: ${preview}`);
			} catch (error) {
				c.pendingSteerUuids.delete(uuid);
				debug("provider: steer push rejected; replaying after the query instead", error);
			}
		}
		if (!delivered) {
			// No open input (e.g. a continuation query): fall back to replaying it as
			// a follow-up once the query ends.
			const text = steer.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
			if (text) c.deferredUserMessages.push(text);
		}
	}
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		piUI?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const sessionKey = (options as { sessionId?: string } | undefined)?.sessionId ?? DEFAULT_SESSION_KEY;
	// OMP's cache warmer re-sending the last request: refresh the cache, not a turn.
	if (isWarmReplay(context, options, sessionKey)) return cacheWarmStream(model, sessionKey, options);
	// Compaction, titles, recaps and other side calls never touch a session mirror.
	if (isOneShotCall(context)) return oneShotStream(model, context, options);

	const slot = sessionSlot(sessionKey);
	// Side requests (OMP sets parentSessionId) get their own short-lived mirror,
	// dropped when they finish so their session files don't pile up.
	const ephemeral = Boolean((options as { parentSessionId?: string } | undefined)?.parentSessionId);
	const stream = newAssistantMessageEventStream();

	// OMP 18 starts some runs with a "developer" message (auto-continue); it is a prompt like a user message.
	const lastRole = context.messages[context.messages.length - 1]?.role;
	const lastMsgRole = lastRole === "developer" ? "user" : lastRole;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	const activeQuery = ctx().activeQuery !== null;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		resultCtx.resetTurnState(model);
		debug(`provider: tool results, ${allResults.length} results, ${resultCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`);
		// A message the user sent while the tool ran (OMP appends it after the tool
		// results). It is written into Claude Code's open input *before* the tool
		// results are released, so Claude Code takes it in at this tool boundary and
		// answers it mid-turn, as a native agent would. Without this, Claude only saw
		// e.g. "Wait interrupted by message." and went back to waiting.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		void deliverToolResults(resultCtx, allResults, steer);
		// The request Claude Code sends next carries these results; a warm replay of it
		// arrives with the same last message.
		const recipe = warmRecipes.get(sessionKey);
		if (recipe) recipe.lastMessage = context.messages[context.messages.length - 1];

		if (slot.s) slot.s.cursor = context.messages.length;
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call, or the query failed) ---
	// The query is gone but OMP still delivered the result. Deliver a failure parked
	// while the tool ran; otherwise end the turn so OMP waits for the next prompt.
	// Uses its own output object: resetting ctx() here would wipe a live query's turn.
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		const parked = pendingTurnErrors.get(sessionKey);
		pendingTurnErrors.delete(sessionKey);
		debug(`provider: orphaned tool result, ${parked ? "delivering parked error" : "emitting end_turn"}`);
		if (slot.s) slot.s.cursor = context.messages.length;
		queueMicrotask(() => {
			if (parked) {
				stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", parked) });
				piUI?.notify(parked.split("\n")[0], "error");
			} else {
				stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, "", "stop") });
			}
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}
	pendingTurnErrors.delete(sessionKey);

	// --- Fresh query ---

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	queryCtx.deferredUserMessages = [];
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = 0;

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);
	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModelFor(model), sessionKey);
	const { sessionId: resumeSessionId } = syncResult;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sessionKey,
			sharedSession: slot.s ? { sessionId: slot.s.sessionId.slice(0, 8), cursor: slot.s.cursor } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// The prompt is a long-lived input stream rather than a string, so messages the
	// user sends mid-turn can be written into the running query (see deliverToolResults).
	// It is closed once a turn ends with no steer still waiting to be taken in.
	const promptStream = makePromptStream();
	void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }])).catch(() => {});
	queryCtx.promptStream = promptStream;
	queryCtx.pendingSteerUuids.clear();
	const mcpServers = buildMcpServers(mcpTools, queryCtx);
	// OMP's persona, skills/rules, project context and append text, verbatim.
	const promptParts = extractOmpPromptParts(context.systemPrompt);
	const forward = forwardSettings(providerSettings.forward);
	const personaStyle = personaStyleFor(promptParts.personality, forward);
	// With the persona delivered as the output style, don't append it a second time.
	const systemPromptAppend = composeAppend(promptParts, personaStyle ? { ...forward, personality: false } : forward);

	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
	const thinking = planThinking(model as any, options ?? {});

	// cliModel is the id sent to Claude Code (may carry [1m]); model.id is OMP's picker id.
	const cliModel = cliModelFor(model);
	// replay-user-messages: Claude Code echoes each input message it takes in, which
	// is how the bridge knows a steer was consumed and the input may be closed.
	const extraArgs: Record<string, string | null> = { model: cliModel, "replay-user-messages": null };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7+ default thinking.display to "omitted" (empty thinking text in the stream).
	if (thinking.display) extraArgs["thinking-display"] = thinking.display;

	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		env: childEnv(),
		// Claude Code's built-in tools are off: OMP executes every tool, served over MCP.
		tools: [],
		// Least privilege: only OMP's MCP tools are allowed, everything else is denied
		// without a prompt. OMP applies its own approvals when it runs the tool.
		permissionMode: "dontAsk",
		allowedTools: [`mcp__${MCP_SERVER_NAME}`],
		includePartialMessages: true,
		// User settings only: a repository's .claude/settings*.json can carry hooks, env
		// and apiKeyHelper, and non-interactive Claude Code trusts the workspace, so they
		// would run with no prompt. ~/.claude/settings.json keeps env/apiKeyHelper.
		settingSources: ["user"] as SettingSource[],
		settings: claudeSettings({ outputStyle: personaStyle?.outputStyle }),
		...(personaStyle ? { plugins: [{ type: "local" as const, path: personaStyle.pluginPath, skipMcpDiscovery: true }] } : {}),
		systemPrompt: {
			type: "preset", preset: "claude_code",
			append: systemPromptAppend,
		},
		extraArgs,
		...thinkingOptions(thinking),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(!resumeSessionId && syncResult.freshSessionId ? { sessionId: syncResult.freshSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};
	// A clean start under the stable id replaces whatever an earlier OMP process left there.
	if (!resumeSessionId && syncResult.freshSessionId) deleteSession(syncResult.freshSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	// What a cache-warm refresh of this conversation must send to match its prefix.
	if (!ephemeral) {
		const { resume: _r, sessionId: _s, mcpServers: _m, stderr: _e, ...warmOptions } = queryOptions as typeof queryOptions & { stderr?: unknown };
		warmRecipes.set(sessionKey, { lastMessage: context.messages[context.messages.length - 1], mcpTools, options: warmOptions });
	}
	// Each request Claude Code makes for this turn goes to the usage ledger.
	const fingerprint = callFingerprint(
		[systemPromptAppend, personaStyle ? promptParts.personality : undefined],
		mcpTools,
		[thinkingOptions(thinking), thinking.display],
	);
	const newTurnMeter = (sync: SyncPath) => new QueryMeter((index, startedAt, tokens, aborted) => recordCall(
		{ ts: startedAt, kind: "turn", model: model.id, session: sessionKey.slice(-8), sync: index === 0 ? sync : "in-query", ...tokens, ...(aborted ? { aborted } : {}) },
		sessionKey,
		fingerprint,
	));
	const turnMeter = newTurnMeter(syncResult.path);

	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${thinking.effort ?? (thinking.disabled ? "off" : "default")}`,
		`append=${systemPromptAppend?.length ?? 0}ch persona=${personaStyle ? "output-style" : promptParts.personality ? "appended" : "none"} strictMcp=${strictMcpConfigEnabled} session=${sessionKey}${ephemeral ? " (side)" : ""}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	const sdkQuery = query({ prompt: promptStream.stream, options: queryOptions });
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);
	if (!accountInfoRequested) {
		// Once per process: the account label for OMP's Usage panel, from the SDK's own accountInfo().
		accountInfoRequested = true;
		void sdkQuery.accountInfo().then((info) => {
			const state = loadUsageState(USAGE_STATE_PATH);
			if (recordAccount(state, info)) saveUsageState(USAGE_STATE_PATH, state);
		}).catch((e) => debug("accountInfo failed", e));
	}

	// 4. Capture context for abort handling
	const abortCtx = queryCtx;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const onAbort = () => {
		wasAborted = true;
		promptStream.fail(new Error("Operation aborted"));
		abortCtx.pendingSteerUuids.clear();
		// Prevent stale deferred messages from being replayed by parent on pop
		abortCtx.deferredUserMessages = [];
		for (const pending of abortCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] }); }
		abortCtx.pendingToolCalls.clear();
		abortCtx.pendingResults.clear();
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	const stopForExtraUsage = () => {
		debug("provider: request billed to Extra Usage; stopping query (allowExtraUsage=false)");
		for (const pending of queryCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Stopped: Extra Usage" }], isError: true }); }
		queryCtx.pendingToolCalls.clear();
		queryCtx.pendingResults.clear();
		requestAbort();
	};

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx, stopForExtraUsage, turnMeter)
		.then(async ({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				if (slot.s) slot.s = { ...slot.s, needsRebuild: true, forceRotate: true };
				queryCtx.deferredUserMessages = [];
				debug(`provider: abort detected, marked slot.s needsRebuild + forceRotate`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				return;
			}

			// --- Failed result or Extra Usage stop: end the turn as an error ---
			if (queryCtx.extraUsageBlocked || queryCtx.resultError) {
				const msg = queryCtx.extraUsageBlocked ? EXTRA_USAGE_STOP_MESSAGE : queryCtx.resultError!;
				// The CC process was cut off mid-turn (or errored): its JSONL is not a
				// trustworthy continuation, so the next turn rebuilds from OMP's history.
				if (slot.s) slot.s = { ...slot.s, needsRebuild: true, forceRotate: queryCtx.extraUsageBlocked };
				queryCtx.deferredUserMessages = [];
				if (queryCtx.activeQuery === sdkQuery) queryCtx.activeQuery = null;
				failTurn(queryCtx, sessionKey, msg);
				return;
			}

			// --- Capture session ID ---
			const sessionId = capturedSessionId ?? slot.s?.sessionId;
			if (syncResult.preserveSharedSession) {
				if (capturedSessionId && capturedSessionId !== slot.s?.sessionId) {
					deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
					debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
				}
				debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
			} else if (sessionId) {
				const cursor = Math.max(context.messages.length, queryCtx.latestCursor, slot.s?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
				slot.s = { sessionId, cursor, cwd, completed: true };
			}

			// --- Replay deferred user messages as continuation queries ---
			try {
				while (queryCtx.deferredUserMessages.length > 0 && !isReentrant && !wasAborted) {
					const steerPrompt = queryCtx.deferredUserMessages.shift()!;
					debug(`provider: replaying deferred user message: ${steerPrompt.slice(0, 60)}`);
					queryCtx.resetTurnState(model);

					const resumeId = slot.s?.sessionId;
					if (!resumeId) {
						debug(`WARNING: no session to resume for deferred message, dropping`);
						break;
					}

					// --session-id can't accompany --resume.
					const { sessionId: _freshId, ...baseOptions } = queryOptions;
					const contOptions = { ...baseOptions, resume: resumeId, ...makeCliDebugOptions("continuation") };
					const contQuery = query({ prompt: steerPrompt, options: contOptions });
					queryCtx.activeQuery = contQuery;

					debug(`provider: continuation query, model=${cliModel}, resume=${resumeId.slice(0, 8)}, prompt=${steerPrompt.slice(0, 60)}`);

					const contMeter = newTurnMeter("continuation");
					try {
						const { capturedSessionId: contSid } = await consumeQuery(contQuery, customToolNameToPi, model, () => wasAborted, queryCtx, () => { try { contQuery.close(); } catch {} }, contMeter);
						const sid = contSid ?? slot.s?.sessionId;
						if (sid) {
							slot.s = { sessionId: sid, cursor: slot.s?.cursor ?? 0, cwd };
						}
					} catch (contError) {
						debug(`provider: continuation query error:`, contError);
						break;
					} finally {
						contMeter.close();
						contQuery.close();
					}
				}
			} finally {
				queryCtx.activeQuery = sdkQuery;
			}

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			const aborted = wasAborted || Boolean(options?.signal?.aborted);
			if ((aborted || queryCtx.extraUsageBlocked) && slot.s) {
				slot.s = { ...slot.s, needsRebuild: true, forceRotate: true };
			} else {
				slot.s = null;
			}
			queryCtx.deferredUserMessages = [];
			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				for (const pending of queryCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Query ended" }] }); }
				queryCtx.pendingToolCalls.clear();
				queryCtx.pendingResults.clear();
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			if (aborted && !queryCtx.extraUsageBlocked) {
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = error instanceof Error ? error.message : String(error);
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				return;
			}
			const msg = queryCtx.extraUsageBlocked
				? EXTRA_USAGE_STOP_MESSAGE
				: explainClaudeError(queryCtx.resultError ?? errorMessage(error));
			failTurn(queryCtx, sessionKey, msg);
		})
		.finally(() => {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			turnMeter.close();
			if (queryCtx.activeQuery === sdkQuery) {
				// Drain pending handlers for this query
				for (const pending of queryCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Query ended" }] }); }
				queryCtx.pendingToolCalls.clear();
				queryCtx.pendingResults.clear();
				queryCtx.activeQuery = null;
			}
			activeQueryContexts.delete(queryCtx);
			promptStream.end();
			if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
			queryCtx.pendingSteerUuids.clear();
			sdkQuery.close();
			if (ephemeral && slot.s) {
				deleteSession(slot.s.sessionId, slot.s.cwd, process.env.CLAUDE_CONFIG_DIR);
				debug(`provider: dropped side-request mirror ${slot.s.sessionId.slice(0, 8)} (${sessionKey})`);
				slot.s = null;
			}
		});

	return stream;
}

// Errors that arrive while OMP is executing a tool have no open stream; they are
// parked per OMP session and delivered on OMP's next call (the tool-result call).
const pendingTurnErrors = new Map<string, string>();

function failTurn(queryCtx: QueryContext, sessionKey: string, msg: string): void {
	if (queryCtx.turnOutput) {
		queryCtx.turnOutput.stopReason = "error";
		queryCtx.turnOutput.errorMessage = msg;
	}
	const stream = queryCtx.currentPiStream;
	if (!stream) {
		pendingTurnErrors.set(sessionKey, msg);
		debug(`provider: no open stream; parked error for next call: ${msg.slice(0, 120)}`);
		return;
	}
	if (!queryCtx.turnStarted) ensureTurnStarted(queryCtx);
	stream.push({ type: "error", reason: "error", error: queryCtx.turnOutput! });
	markStreamComplete(stream);
	stream.end();
	queryCtx.currentPiStream = null;
	piUI?.notify(msg.split("\n")[0], "error");
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: AskClaudeMode,
	toolCalls: Map<string, ToolCallState>,
	signal: AbortSignal | undefined,
	options: {
		cwd: string;
		systemPrompt?: string[];
		forward?: ForwardSettings;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
	},
): Promise<{ responseText: string; stopReason: string }> {
	const cwd = options.cwd;
	const requestedModel = options.model ?? "opus";
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? requestedModel;
	const cliModel = model ? cliModelFor(model) : modelId;

	// Shared mode: give Claude OMP's current history. Synced into a mirror of its own
	// (never the provider's: AskClaude only runs when another provider is active, so
	// a provider mirror would be stale), then forked so the run doesn't alter it.
	let resumeSessionId: string | null = null;
	if (!options.isolated && options.context?.length) {
		const contextWithPrompt = [...options.context, { role: "user" as const, content: prompt, timestamp: Date.now() }];
		resumeSessionId = syncSharedSession(contextWithPrompt as Context["messages"], cwd, undefined, cliModel, ASKCLAUDE_SESSION_KEY).sessionId;
	}

	const policy = askClaudeToolPolicy(mode);
	const append = composeAppend(extractOmpPromptParts(options.systemPrompt), { personality: false, ...options.forward });
	const thinking = planThinking((model ?? {}) as any, { reasoning: options.thinking });
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
	const extraArgs: Record<string, string | null> = { "strict-mcp-config": null, model: cliModel };
	if (thinking.display) extraArgs["thinking-display"] = thinking.display;

	debug("askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${thinking.effort ?? (thinking.disabled ? "off" : "default")}`,
		`isolated=${options.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`append=${append?.length ?? 0}ch promptLen=${prompt.length}`);

	const sdkQuery = query({
		prompt,
		options: {
			cwd,
			env: childEnv(),
			tools: policy.tools,
			permissionMode: policy.permissionMode,
			...(policy.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
			...(policy.allowedTools ? { allowedTools: policy.allowedTools } : {}),
			...(policy.disallowedTools ? { disallowedTools: policy.disallowedTools } : {}),
			includePartialMessages: true,
			// Claude Code's own tools run here, so its git guidance stays on.
			settingSources: ["user"] as SettingSource[],
			settings: claudeSettings({ gitInstructions: true }),
			systemPrompt: { type: "preset", preset: "claude_code", append },
			extraArgs,
			...thinkingOptions(thinking),
			...(resumeSessionId ? { resume: resumeSessionId, forkSession: true } : {}),
			...(options.isolated ? { persistSession: false } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...makeCliDebugOptions("askclaude"),
		},
	});

	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} });
	};
	if (signal?.aborted) { onAbort(); throw new Error("Aborted"); }
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";
	let sdkMessageCount = 0;
	let textDeltaCount = 0;
	let resultSubtype: string | undefined;
	let failure: string | undefined;
	let forkedSessionId: string | undefined;

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			switch (message.type) {
				case "system":
					if ((message as any).subtype === "init") forkedSessionId = (message as any).session_id;
					break;
				case "stream_event": {
					const event = (message as SDKMessage & { event: any }).event;
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						textDeltaCount++;
						options.onStreamUpdate?.(responseText);
					}
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						toolCalls.set(event.content_block.id, { name: mapToolName(event.content_block.name), status: "running" });
					}
					break;
				}
				case "assistant": {
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, { name: mapToolName(block.name), status: "complete", rawInput: block.input });
						}
					}
					break;
				}
				case "rate_limit_event": {
					if (reportRateLimit((message as any).rate_limit_info) && !providerSettings.allowExtraUsage) {
						failure = EXTRA_USAGE_STOP_MESSAGE;
						onAbort();
					}
					break;
				}
				case "result": {
					resultSubtype = message.subtype;
					const r = message as any;
					if (r.usage) {
						debug(`askClaude: result usage: in=${r.usage.input_tokens} out=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens ?? 0} cacheWrite=${r.usage.cache_creation_input_tokens ?? 0} turns=${r.num_turns ?? "?"}`);
						recordCall({ ts: Date.now(), kind: "askclaude", model: cliModel, ...tokensFromReport(r.usage) });
					}
					if (isErrorResult(message)) failure ??= explainClaudeError(resultErrorText(message));
					else if (!responseText && r.result) responseText = r.result;
					break;
				}
			}
		}

		debug(`askClaude: done resultSubtype=${resultSubtype ?? "none"} sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length} toolCalls=${toolCalls.size}`);
		if (failure) throw new Error(failure);
		return { responseText, stopReason: wasAborted ? "cancelled" : "stop" };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
		// The fork is a throwaway copy of the mirror; don't leave it on disk.
		if (resumeSessionId && forkedSessionId && forkedSessionId !== resumeSessionId) {
			deleteSession(forkedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
		}
	}
}

const ASKCLAUDE_SESSION_KEY = "askclaude";

function forwardSettings(forward: ForwardSettings | undefined): ForwardSettings {
	return { personality: true, skills: true, projectContext: true, appendText: true, ...forward };
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude (running in Claude Code) for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude (running in Claude Code) for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

let askClaudeToolName = "AskClaude";

export default function (pi: ExtensionAPI) {
	const config = loadConfig(process.cwd());
	debug(`load: ${CLIENT_APP} module=${moduleInstanceId} config=${JSON.stringify(config)}`);
	providerSettings = config.provider ?? {};
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
		contextWindow: providerSettings.contextWindow ?? "auto",
		forceTwoHundredK: providerSettings.forceTwoHundredK,
	};
	MODELS = buildModels(getModels("anthropic"), providerSettings.excludeModels);
	// The cache lifetime Claude Code is told to use (provider.promptCacheTtl), declared
	// so OMP's cache warmer can refresh entries before they expire. Both tiers carry
	// it: Claude Code, not OMP's retention setting, decides what is written.
	const cacheSeconds = promptCacheSeconds(providerSettings.promptCacheTtl);
	const registeredModels = buildVariantModels(MODELS, longContextSettings)
		.map((m) => cacheSeconds ? { ...m, promptCache: { short: cacheSeconds, long: cacheSeconds } } : m);

	// OMP session lifecycle: drop every mirror this instance holds. Subagent sessions
	// that route through this instance simply rebuild on their next turn.
	const clearSessions = (event: string) => {
		debug(`${event}: clearing ${sessions.size} session mirror(s)`);
		sessions.clear();
		pendingTurnErrors.clear();

		// Clear the global streamSimple if this instance registered it, so /reload
		// can register fresh instead of wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	let authNoticeShown = false;
	pi.on("session_start", (_event, ctx) => {
		piUI = ctx.ui;
		clearSessions("session_start");
		// Default billing leaves Claude Code's auth untouched; say so when the environment
		// would route it somewhere other than the user's Claude login.
		const billing = providerSettings.billing ?? "inherit";
		const notice = billing === "inherit" ? authRouteNotice() : undefined;
		if (notice && !authNoticeShown) {
			authNoticeShown = true;
			ctx.ui?.notify?.(notice, "warning");
		}
	});
	pi.on("session_switch", (event) => clearSessions(`session_switch:${event.reason}`));
	pi.on("session_branch", () => clearSessions("session_branch"));
	pi.on("session_shutdown", () => {
		// A query parked on a tool call would otherwise keep its Claude Code process
		// (and OMP's event loop) alive after OMP exits.
		for (const queryCtx of activeQueryContexts) {
			for (const pending of queryCtx.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: "Session ended" }] });
			try { (queryCtx.activeQuery as { close?: () => void } | null)?.close?.(); } catch { /* ignore */ }
		}
		activeQueryContexts.clear();
		clearSessions("session_shutdown");
	});

	// /compact and session-tree navigation rewrite OMP's history under the bridge;
	// force the next call down the REBUILD path so Claude Code sees the new history.
	// (Compaction itself needs no takeover: OMP's summary call is tool-less and runs
	// through the isolated one-shot path.)
	const markRebuild = (event: string) => {
		for (const [key, state] of sessions) {
			debug(`${event}: marking needsRebuild on ${key} (${state.sessionId.slice(0, 8)})`);
			sessions.set(key, { ...state, needsRebuild: true, cleanBytes: undefined, completed: false });
		}
		// The next request's cache miss follows from the rewrite; the ledger says so.
		for (const key of lastCalls.keys()) rewrittenSessions.add(key);
	};
	// Idle cache warming on a Claude plan: see cache-warming.ts for why OMP's dollar floor
	// is dropped for bridge turns. On an API key (or any non-Claude-login route) OMP decides.
	pi.on("cache_warming_decision", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID || providerSettings.cacheWarming === "omp") return undefined;
		const billing = providerSettings.billing ?? "inherit";
		const onSubscription = billing === "subscription" || (billing === "inherit" && !authRouteNotice());
		const action = subscriptionWarmingAction(event, onSubscription);
		debug(`cache-warm decision: omp=${event.action} bridge=${action ?? "-"} p=${event.continuationProbability} miss=$${event.missCost.toFixed(4)} warm=$${event.warmCost.toFixed(4)}`);
		return action ? { action } : undefined;
	});

	pi.on("session_compact", (event) => markRebuild(`session_compact:fromExtension=${event.fromExtension}`));
	pi.on("session_tree", () => markRebuild("session_tree"));

	// /claude-usage [hours]: what the bridge spent from the ledger, with any cache misses
	// or usage Claude Code reported that the bridge never saw.
	pi.registerCommand("claude-usage", {
		description: "Claude bridge usage, cache misses and unseen usage: /claude-usage [hours] | off",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off") {
				ctx.ui.setWidget("claude-bridge-usage", undefined);
				return;
			}
			const hours = Number(arg) > 0 ? Number(arg) : 24;
			const summary = summarizeLedger(readLedger(LEDGER_PATH, Date.now() - hours * 3_600_000));
			ctx.ui.setWidget("claude-bridge-usage", [...formatReport(summary, hours, LEDGER_PATH), "  (/claude-usage off to close)"]);
		},
	});

	// --- Provider ---
	//
	// Guard against re-registration when the module is loaded multiple times
	// (e.g., when spawning subagents). The shared ModelRegistry would otherwise
	// overwrite the parent's streamSimple, breaking tool result delivery.
	// See ACTIVE_STREAM_SIMPLE_KEY for the full mechanism.

	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge",
			models: registeredModels,
			// Cast: pi-ai AssistantMessageEventStream diamond dep between pi-coding-agent and pi-agent-core
			streamSimple: streamClaudeAgentSdk as any,
			// OMP's Usage panel. Read from disk on each fetch so every OMP process shows
			// the latest figures Claude Code reported, whichever process ran the turn.
			usage: {
				id: PROVIDER_ID,
				fetchUsage: async () => buildUsageReport(PROVIDER_ID, loadUsageState(USAGE_STATE_PATH)),
			} as any,
		});
	} else {
		// Subsequent instance (subagent session): skip registration entirely.
		// The subagent already has access to claude-bridge models via the shared
		// ModelRegistry from the parent's registration. Calls to those models
		// route through the parent's streamSimple via reentrant QueryContexts.
		debug(`provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`);
	}

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const allowFull = askConf?.allowFullMode !== false;
	const defaultMode = askConf?.defaultMode ?? "read";
	const defaultIsolated = askConf?.defaultIsolated ?? false;
	askClaudeToolName = askConf?.name ?? "AskClaude";

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	type AskClaudeToolParams = {
		prompt: string;
		mode?: "full" | "read" | "none";
		model?: string;
		thinking?: string;
		isolated?: boolean;
	};

	const readAskClaudeParams = (value: unknown, requirePrompt: boolean): AskClaudeToolParams => {
		if (!value || typeof value !== "object") {
			if (requirePrompt) throw new Error("AskClaude prompt must be a string");
			return { prompt: "" };
		}
		if (!("prompt" in value) || typeof value.prompt !== "string") {
			if (requirePrompt) throw new Error("AskClaude prompt must be a string");
			return { prompt: "" };
		}
		const parsed: AskClaudeToolParams = { prompt: value.prompt };
		if ("mode" in value && (value.mode === "full" || value.mode === "read" || value.mode === "none")) parsed.mode = value.mode;
		if ("model" in value && typeof value.model === "string") parsed.model = value.model;
		if ("thinking" in value && typeof value.thinking === "string") parsed.thinking = value.thinking;
		if ("isolated" in value && typeof value.isolated === "boolean") parsed.isolated = value.isolated;
		return parsed;
	};

	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to OMP).`;
	const defaultModel = askConf?.defaultModel ?? "opus";

	if (askConf?.enabled !== false) {
		const askClaudeParams = Type.Object({
			prompt: Type.String({ description: "The question or task for Claude. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
			mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
			model: Type.Optional(Type.String({ description: `Claude model ("opus", "sonnet", "haiku", "fable" pick the newest of that family, or a full id). Defaults to "${defaultModel}".` })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
			isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
		});
		pi.registerTool<typeof askClaudeParams>({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: askClaudeParams,
			// Without full mode it can only read, so OMP's approval tier can say so.
			approval: allowFull ? "exec" : "read",
			renderCall(args, _options, theme) {
				const params = readAskClaudeParams(args, false);
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const mode = params.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== defaultMode) tags.push(`mode=${mode}`);
				if (params.model) tags.push(`model=${params.model}`);
				if (params.thinking) tags.push(`thinking=${params.thinking}`);
				if (params.isolated) tags.push("isolated");
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated = params.prompt.length > PREVIEW_MAX_CHARS ? params.prompt.substring(0, PREVIEW_MAX_CHARS) : params.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (params.prompt.length > PREVIEW_MAX_CHARS || params.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error
					? theme.fg("error", "✗ Claude error")
					: theme.fg("mdLink", "✓ Claude");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", "… (expand to see all)")}`;

				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					debug("askClaude: blocked circular delegation (active provider is claude-bridge)");
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code." }],
						details: { error: true },
					};
				}

				const askParams = readAskClaudeParams(params, true);
				const mode = askParams.mode ?? defaultMode;
				const isolated = askParams.isolated ?? defaultIsolated;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: askParams.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(askParams.prompt, mode, toolCalls, signal, {
						cwd: ctx.cwd,
						systemPrompt: ctx.getSystemPrompt(),
						forward: askConf?.forward,
						model: askParams.model ?? defaultModel,
						thinking: askParams.thinking,
						isolated,
						context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions
						? `${result.responseText}\n\n[Claude actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: askParams.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					debug(`askClaude error: mode=${mode}, model=${askParams.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: askParams.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}
