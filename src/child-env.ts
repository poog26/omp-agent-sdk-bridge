// Environment for every Claude Code subprocess the bridge spawns (provider,
// one-shot summaries, AskClaude). One builder so a guard is added once.

export type BillingMode = "subscription" | "apiKey" | "inherit";
export type PromptCacheTtl = "5m" | "1h" | "default";

/** Seconds a prompt-cache entry lives under `ttl`, as Claude Code requests it. */
export function promptCacheSeconds(ttl: PromptCacheTtl = "5m"): number | undefined {
	return ttl === "5m" ? 300 : ttl === "1h" ? 3600 : undefined;
}

// Guards that always hold. Each is a variable Anthropic documents for Claude Code
// (code.claude.com/docs/en/env-vars); undocumented internal flags are never set, and
// tests/unit-modules.mjs fails if one is added.
// - ENABLE_CLAUDEAI_MCP_SERVERS=false: claude.ai-connected MCP servers stay out; OMP serves its own tools.
// - DISABLE_AUTO_COMPACT=1: OMP owns compaction. CC compacting its own copy would
//   diverge from OMP's history, which every rebuild is made from.
// - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1: no update checks or telemetry from the
//   child. Set here, never on OMP's own process.env, so it can't leak into OMP's bash.
// - CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS=1: a resumed session ending at a tool
//   result reads to CC as an interrupted turn, and CC may insert "Continue from where you
//   left off." ahead of OMP's prompt. OMP supplies every prompt.
const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "false",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
} as const;

// Set by Claude Code on its own children. When OMP itself was started from inside a
// Claude Code session they describe that session, not ours — and the SDK only stamps
// its own entrypoint/version when these are unset, so leaving them would misattribute
// the bridge's requests.
const PARENT_SESSION_VARS = [
	"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_PID", "CLAUDE_EFFORT", "TRACEPARENT", "CLAUDE_CODE_INVOKED_SKILLS", "CLAUDE_ENV_FILE",
	"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH",
	"CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
];

// Variables that send Claude Code somewhere other than the user's claude.ai login.
// Default ("inherit") leaves them alone: Anthropic's terms for products that run
// Claude Code forbid removing or restricting any of its built-in auth methods, so the
// bridge only *reports* them (authRouteNotice). "subscription" removes them, as the
// user's own explicit choice.
const NON_SUBSCRIPTION_AUTH_VARS = [
	"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
];

export interface ChildEnvOptions {
	billing?: BillingMode;
	/** Value for CLAUDE_AGENT_SDK_CLIENT_APP, e.g. "omp-agent-sdk-bridge/0.9.0". */
	clientApp?: string;
	/** Prompt-cache lifetime; "default" leaves Claude Code's own choice. Default "5m". */
	promptCacheTtl?: PromptCacheTtl;
}

/**
 * Describes auth/routing variables that would make Claude Code bill something other
 * than the user's claude.ai login, or undefined when there are none. A base URL that
 * is Anthropic's own API is not a different route.
 */
export function authRouteNotice(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const found = NON_SUBSCRIPTION_AUTH_VARS.filter((name) => {
		const value = env[name];
		if (!value) return false;
		if (name === "ANTHROPIC_BASE_URL") {
			try { return new URL(value).hostname !== "api.anthropic.com"; } catch { return true; }
		}
		return true;
	});
	if (!found.length) return undefined;
	return `claude-bridge: ${found.join(", ")} ${found.length === 1 ? "is" : "are"} set, so Claude Code will use ` +
		`${found.length === 1 ? "it" : "them"} instead of your Claude login (and bill accordingly). ` +
		`Set provider.billing to "subscription" in claude-bridge.json to use only your Claude login.`;
}

export function ccChildEnv(opts: ChildEnvOptions = {}, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const billing = opts.billing ?? "inherit";
	const env: NodeJS.ProcessEnv = { ...parent };
	if (parent.CLAUDECODE) for (const name of PARENT_SESSION_VARS) delete env[name];
	if (billing === "subscription") for (const name of NON_SUBSCRIPTION_AUTH_VARS) delete env[name];
	if (billing === "apiKey" && !env.ANTHROPIC_API_KEY) {
		throw new Error(
			'claude-bridge: provider.billing is "apiKey" but ANTHROPIC_API_KEY is not set. ' +
			'Export a Claude Console key, or set provider.billing to "subscription".',
		);
	}
	// Identify the bridge in Claude Code's User-Agent, the way the Agent SDK documents
	// for apps built on it. Requests stay honestly attributed; nothing is spoofed.
	if (opts.clientApp) env.CLAUDE_AGENT_SDK_CLIENT_APP = opts.clientApp;
	// Claude Code's documented TTL controls, for both of its request buckets (main
	// conversation, and side requests such as titles). On a subscription it would
	// otherwise write 1h entries, billed at 2x input against 1.25x for 5m; measured on
	// real bridge sessions, 5m came out ~10% cheaper, misses from longer pauses included.
	const ttl = opts.promptCacheTtl ?? "5m";
	if (ttl !== "default") {
		env.CLAUDE_CODE_PROMPT_CACHE_TTL = ttl;
		env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = ttl;
	}
	// NONESSENTIAL_TRAFFIC also stops Claude Code fetching the feature flag that turns on
	// fine-grained tool streaming, so tool input (a write's content) would arrive in one
	// piece after Claude finished generating it. An explicit "0" from the user still opts out.
	env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING ??= "1";
	return { ...env, ...CC_CHILD_ENV };
}
