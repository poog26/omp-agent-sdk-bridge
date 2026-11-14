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

	// provider.cacheWarming: a typo falls back to the default instead of breaking startup.
	const { validateConfig } = await import("../src/config.ts");
	const warnings: string[] = [];
	check("provider.cacheWarming keeps 'omp' and drops unknown values",
		validateConfig({ provider: { cacheWarming: "omp" } }, (m) => warnings.push(m)).provider?.cacheWarming === "omp" &&
		validateConfig({ provider: { cacheWarming: "always" as never } }, (m) => warnings.push(m)).provider?.cacheWarming === undefined &&
		warnings.length === 1, warnings.join(" | "));

	// Usage is priced by OMP's own calculator on the bridge's registered models, so a
	// turn's footer cost matches what OMP shows for any other model.
	const { getModels, calculateCost } = await import("@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim");
	const { buildModels } = await import("../src/models.ts");
	const registered = buildModels(getModels("anthropic") as never[]).find((m) => m.id === "claude-opus-5-5");
	check("bridge keeps OMP's list price for claude-opus-5-5", registered?.cost.input === 4 && registered?.cost.output === 20,
		JSON.stringify(registered?.cost));
	const priced = calculateCost(registered as never, {
		input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as never);
	check("OMP prices a bridge turn with a non-zero total", Math.abs(priced.total - 14) < 1e-9, JSON.stringify(priced));

	// The picker is built at load from OMP's refreshed Anthropic catalog, read offline from
	// OMP's cache by OMP's own catalog manager; an empty cache falls back to the bundled one.
	const { createModelManager } = await import("@oh-my-pi/pi-catalog");
	const { anthropicModelManagerOptions } = await import("@oh-my-pi/pi-catalog/provider-models");
	const offline = await createModelManager(anthropicModelManagerOptions()).refresh("offline");
	check("OMP's Anthropic catalog manager resolves offline with Claude models",
		Array.isArray(offline.models) && offline.models.some((m) => m.id.startsWith("claude-")),
		`source=${offline.source} count=${offline.models.length}`);

	// OMP's own wire conversion feeds the bridge; nested fields must survive to Claude.
	const { type } = await import("@oh-my-pi/omptype");
	const { toolWireSchema } = await import("@oh-my-pi/pi-ai");
	const { z } = await import("zod");
	const { jsonSchemaToZodSchema } = await import("../src/typebox-to-zod.ts");
	const wire = toolWireSchema({
		name: "nested", description: "",
		parameters: type({ steps: type({ method: "string", args: "unknown[]" }).array(), "mode?": "'a' | 'b'" }),
	} as never);
	const listed = z.toJSONSchema(jsonSchemaToZodSchema(wire), { target: "draft-7", io: "input" }) as Record<string, any>;
	check("nested OMP tool fields reach Claude's tool list",
		JSON.stringify(listed.properties) === JSON.stringify(wire.properties) && JSON.stringify(listed.required) === JSON.stringify(wire.required),
		`wire=${JSON.stringify(wire)}\n     listed=${JSON.stringify(listed)}`);

	// OMP previews a tool call while it streams from the raw JSON on its own symbol;
	// a bridge block without it rendered only once the call was complete.
	const { getStreamingPartialJson } = await import("@oh-my-pi/pi-ai/utils/block-symbols");
	const { __test } = await import("../src/index.ts");
	const { QueryContext } = await import("../src/query-state.ts");
	const { MCP_TOOL_PREFIX } = await import("../src/skills.ts");
	const qc = new QueryContext();
	const model = { id: "claude-haiku-5-5", api: "claude-bridge", provider: "claude-bridge" } as never;
	qc.resetTurnState(model);
	qc.currentPiStream = { push() {}, end() {} } as never;
	const feed = (event: unknown) => __test.processStreamEvent({ type: "stream_event", event } as never, new Map(), model, qc);
	feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: `${MCP_TOOL_PREFIX}write`, input: {} } });
	feed({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\": \"a.txt\", \"content\": \"Rain ta" } });
	const streaming = qc.turnBlocks[0];
	check("a streaming tool call carries OMP's partial JSON and partial arguments",
		getStreamingPartialJson(streaming) === "{\"path\": \"a.txt\", \"content\": \"Rain ta" && streaming.arguments.content === "Rain ta",
		JSON.stringify({ partial: getStreamingPartialJson(streaming), args: streaming.arguments }));
	feed({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "ps\"}" } });
	feed({ type: "content_block_stop", index: 0 });
	check("a finished tool call has complete arguments and no partial JSON",
		getStreamingPartialJson(streaming) === undefined && streaming.arguments.content === "Rain taps" && streaming.name === "write",
		JSON.stringify(streaming));
} catch (e) {
	check("contract run", false, String((e as Error)?.stack ?? e));
}

console.log(failures ? `\n${failures} contract check(s) failed` : "\nall contract checks passed");
process.exit(failures ? 1 : 0);
