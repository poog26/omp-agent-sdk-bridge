// Environment for every Claude Code subprocess the bridge spawns (provider,
// one-shot summaries, AskClaude). One builder so a guard is added once.

export type BillingMode = "subscription" | "apiKey" | "inherit";

// Guards that always hold:
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: claude.ai-connected MCP servers stay out; OMP serves its own tools.
// - DISABLE_AUTO_COMPACT=1: OMP owns compaction. CC compacting its own copy would
//   diverge from OMP's history, which every rebuild is made from.
// - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1: no update checks or telemetry from the
//   child. Set here, never on OMP's own process.env, so it can't leak into OMP's bash.
// - CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS=1: a resumed session ending at a tool
//   result reads to CC as an interrupted turn, and CC may insert "Continue from where you
//   left off." ahead of OMP's prompt. OMP supplies every prompt.
// - CLAUDE_CODE_ELEGANT_MEADOW=0: CC 2.1.308+ otherwise logs every API request into its
//   session file, about a third more disk for records CC never reads back.
const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
	CLAUDE_CODE_ELEGANT_MEADOW: "0",
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
// In "subscription" mode they are removed so an API key or gateway exported for some
// other tool can't silently redirect (and bill) the bridge.
const NON_SUBSCRIPTION_AUTH_VARS = [
	"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
];

export interface ChildEnvOptions {
	billing?: BillingMode;
	/** Value for CLAUDE_AGENT_SDK_CLIENT_APP, e.g. "omp-agent-sdk-bridge/0.9.0". */
	clientApp?: string;
}

export function ccChildEnv(opts: ChildEnvOptions = {}, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const billing = opts.billing ?? "subscription";
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
	return { ...env, ...CC_CHILD_ENV };
}
