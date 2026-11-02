// User-facing extension config, loaded once at registration.
//
//   global:  <agentDir>/claude-bridge.json      (~/.omp/agent/claude-bridge.json)
//   project: <cwd>/.omp/claude-bridge.json      (askClaude settings only)
//
// `provider` is read from the global file only. It decides which executable runs,
// how requests are billed and which Claude Code hooks fire, so a cloned repository
// must not be able to set it. Missing or unparseable files are ignored (error on
// console.error) so the extension always starts.

import type { BillingMode } from "./child-env.js";
import type { AskClaudeMode } from "./askclaude-tools.js";
import type { ContextWindowMode } from "./models.js";
import { CONFIG_DIR_NAME, getAgentDir } from "@oh-my-pi/pi-utils";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ForwardSettings {
	/** OMP personality block (PERSONALITY.md or preset). */
	personality?: boolean;
	/** Skills, always-apply rules and domain rules. */
	skills?: boolean;
	/** <project-context>: workstation, AGENTS.md / context files, workspace tree. */
	projectContext?: boolean;
	/** APPEND_SYSTEM.md / --append-system-prompt text. */
	appendText?: boolean;
}

export interface Config {
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: AskClaudeMode;
		defaultModel?: string;
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		/** What of OMP's prompt reaches a delegated Claude. Personality is off by default. */
		forward?: ForwardSettings;
	};
	provider?: {
		/** "inherit" (default): Claude Code picks its login as usual; "subscription": claude.ai login only; "apiKey": ANTHROPIC_API_KEY. */
		billing?: BillingMode;
		/** Keep going when a request is billed to Extra Usage. Default false: the turn stops. */
		allowExtraUsage?: boolean;
		/** "max" enables Opus 4.6 at 1M by default. */
		plan?: "pro" | "max";
		/** Opt into metered 1M context for Sonnet 4.6 / Opus 4.6 on Pro. */
		longContextExtraUsage?: boolean;
		/** Which window the unsuffixed model id uses. Both stay in the picker. */
		contextWindow?: ContextWindowMode;
		/** Model ids whose default window is pinned to 200K. */
		forceTwoHundredK?: string[];
		/** Substrings of model ids to hide from the picker. Default ["mythos"]. */
		excludeModels?: string[];
		/** What of OMP's prompt reaches Claude on the provider path. All on by default. */
		forward?: ForwardSettings;
		/** How OMP's personality reaches Claude: "outputStyle" (default) replaces Claude Code's terminal-tone section; "append" adds it after the preset. */
		personaAs?: "outputStyle" | "append";
		/** Run hooks from ~/.claude/settings.json on bridge turns. Default false: OMP owns hooks. */
		claudeHooks?: boolean;
		/** Apply Claude Code's configured output style. Default false: OMP owns persona. */
		claudeOutputStyle?: boolean;
		/** Let Claude Code write its auto-memory. Default false: OMP owns memory. */
		autoMemoryEnabled?: boolean;
		/** Block MCP servers from ~/.claude.json / .mcp.json. Default true. */
		strictMcpConfig?: boolean;
		/** Path to the claude binary when the SDK's bundled one can't run. */
		pathToClaudeCodeExecutable?: string;
	};
}

const BILLING_MODES = new Set(["subscription", "apiKey", "inherit"]);
const WINDOW_MODES = new Set(["auto", "1m", "200k"]);
const ASK_MODES = new Set(["read", "none", "full"]);

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

/** Drop invalid enum values (with a warning) so a typo never breaks startup. */
export function validateConfig(config: Config, warn: (msg: string) => void = console.error): Config {
	const p = config.provider ?? {};
	if (p.billing !== undefined && !BILLING_MODES.has(p.billing)) {
		warn(`claude-bridge: invalid provider.billing "${String(p.billing)}", using "inherit"`);
		delete p.billing;
	}
	if (p.contextWindow !== undefined && !WINDOW_MODES.has(p.contextWindow)) {
		warn(`claude-bridge: invalid provider.contextWindow "${String(p.contextWindow)}", using "auto"`);
		delete p.contextWindow;
	}
	if (p.personaAs !== undefined && p.personaAs !== "outputStyle" && p.personaAs !== "append") {
		warn(`claude-bridge: invalid provider.personaAs "${String(p.personaAs)}", using "outputStyle"`);
		delete p.personaAs;
	}
	if (p.plan !== undefined && p.plan !== "pro" && p.plan !== "max") {
		warn(`claude-bridge: invalid provider.plan "${String(p.plan)}", using "pro"`);
		delete p.plan;
	}
	const a = config.askClaude ?? {};
	if (a.defaultMode !== undefined && !ASK_MODES.has(a.defaultMode)) {
		warn(`claude-bridge: invalid askClaude.defaultMode "${String(a.defaultMode)}", using "read"`);
		delete a.defaultMode;
	}
	return { askClaude: a, provider: p };
}

export function loadConfig(cwd: string, globalPath: string = globalConfigPath()): Config {
	const global = tryParseJson(globalPath);
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	if (project.provider) {
		console.error(`claude-bridge: ignoring "provider" in ${join(cwd, CONFIG_DIR_NAME, "claude-bridge.json")}; provider settings are global-only`);
	}
	return validateConfig({
		askClaude: { ...global.askClaude, ...narrowOnly(project.askClaude) },
		provider: { ...global.provider },
	});
}

/** A project may restrict AskClaude but not widen it into unattended write/bash access. */
function narrowOnly(askClaude: Config["askClaude"]): Config["askClaude"] {
	if (!askClaude) return {};
	const { defaultMode, allowFullMode, ...rest } = askClaude;
	return {
		...rest,
		...(defaultMode !== undefined && defaultMode !== "full" ? { defaultMode } : {}),
		...(allowFullMode === false ? { allowFullMode } : {}),
	};
}
