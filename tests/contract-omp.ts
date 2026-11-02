// Contract checks against the installed OMP packages. They catch upstream drift that
// unit tests with synthetic input can't: a renamed prompt section, a moved marker, a
// config-loading change. Run through tests/run-contract.mjs, which prepares a throwaway
// agent dir (OCB_CONTRACT_DIR) so the user's real PERSONALITY.md / config are never read.
// Needs bun: OMP's sources use bun text imports. This file only reads.

import { join } from "node:path";

const agentDir = process.env.OCB_CONTRACT_DIR;
if (!agentDir) {
	console.error("OCB_CONTRACT_DIR is not set; run `node tests/run-contract.mjs`");
	process.exit(2);
}
process.env.PI_CODING_AGENT_DIR = agentDir;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n     ${detail}` : ""}`);
	if (!ok) failures++;
}

try {
	const { buildSystemPrompt } = await import("@oh-my-pi/pi-coding-agent/system-prompt");
	const { composeAppend, extractOmpPromptParts, isAgentPrompt } = await import("../src/omp-prompt.ts");

	const { systemPrompt } = await buildSystemPrompt({
		cwd: agentDir,
		toolNames: ["read", "bash", "edit", "write", "grep", "glob"],
		contextFiles: [{ path: join(agentDir, "AGENTS.md"), content: "CONTRACT PROJECT RULE" }],
		appendSystemPrompt: "CONTRACT APPEND TEXT",
		skills: [{ name: "contract-skill", description: "Contract skill description", filePath: join(agentDir, "s", "SKILL.md"), baseDir: join(agentDir, "s"), source: "user" }],
	} as any);

	const parts = extractOmpPromptParts(systemPrompt);
	check("OMP renders the main agent prompt with a <project-context> block", isAgentPrompt(systemPrompt));
	check("personality comes from PERSONALITY.md, including its subheadings",
		!!parts.personality?.includes("CONTRACT PERSONA LINE") && !!parts.personality?.includes("## Persona subheading"),
		JSON.stringify(parts.personality?.slice(0, 200)));
	check("personality stops at the next § section", !parts.personality?.includes("§ "));
	check("skills block lists the skill", !!parts.skillsAndRules?.includes("- contract-skill: Contract skill description"),
		JSON.stringify(parts.skillsAndRules?.slice(0, 200)));
	check("project context carries context files", !!parts.projectContext?.includes("CONTRACT PROJECT RULE"));
	check("append text is captured after OMP's <critical> block", parts.appendText === "CONTRACT APPEND TEXT",
		JSON.stringify(parts.appendText));

	const append = composeAppend(parts) ?? "";
	check("OMP's harness role line is not forwarded", !append.includes("trusted coding assistant"));
	check("OMP's tool policy section is not forwarded", !append.includes("§ Tool Policy"));

	// Config: provider settings are global-only; a project can only narrow AskClaude.
	const { loadConfig } = await import("../src/config.ts");
	const origError = console.error;
	console.error = () => {};
	const config = loadConfig(join(agentDir, "proj"));
	console.error = origError;
	check("project file cannot set provider settings",
		config.provider?.pathToClaudeCodeExecutable === undefined && config.provider?.billing === undefined && config.provider?.plan === "max",
		JSON.stringify(config.provider));
	check("project file cannot widen AskClaude to full mode", config.askClaude?.defaultMode === "read", JSON.stringify(config.askClaude));
	check("project file can still set harmless AskClaude fields", config.askClaude?.label === "Project label");
} catch (e) {
	check("contract run", false, String((e as Error)?.stack ?? e));
}

console.log(failures ? `\n${failures} contract check(s) failed` : "\nall contract checks passed");
process.exit(failures ? 1 : 0);
