// AskClaude tool policy per mode.
//
// An allowlist, not a blocklist: a blocklist misses every tool Claude Code adds
// later (on Windows the old "read" mode still allowed PowerShell and Monitor, so a
// "read-only" delegation could run commands). Read-only modes also skip
// bypassPermissions entirely: only the listed tools exist, and anything else is
// denied without a prompt.

export type AskClaudeMode = "read" | "none" | "full";

export interface AskClaudeToolPolicy {
	/** Built-in tool set passed as `tools`. */
	tools: string[] | { type: "preset"; preset: "claude_code" };
	allowedTools?: string[];
	disallowedTools?: string[];
	permissionMode: "dontAsk" | "bypassPermissions";
}

/** Read-only exploration tools. Grep/Glob are listed explicitly: native builds omit them otherwise. */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"];

/** Interactive or harness-bound tools that can't work inside a delegated, unattended run. */
export const ALWAYS_BLOCKED = [
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "ToolSearch", "ScheduleWakeup",
	"CronCreate", "CronDelete", "RemoteTrigger", "PushNotification",
];

export function askClaudeToolPolicy(mode: AskClaudeMode): AskClaudeToolPolicy {
	switch (mode) {
		case "none":
			return { tools: [], permissionMode: "dontAsk" };
		case "read":
			return { tools: READ_ONLY_TOOLS, allowedTools: READ_ONLY_TOOLS, permissionMode: "dontAsk" };
		case "full":
			return { tools: { type: "preset", preset: "claude_code" }, disallowedTools: ALWAYS_BLOCKED, permissionMode: "bypassPermissions" };
	}
}
