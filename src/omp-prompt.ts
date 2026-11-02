// Projection of OMP's system prompt onto Claude Code's.
//
// Claude Code keeps its own `claude_code` preset as the agent framework; the
// bridge appends only the parts of OMP's prompt that belong to the user:
//
//   - the personality block (PERSONALITY.md or the configured preset)
//   - skills, always-apply rules and domain rules
//   - the <project-context> block (workstation, AGENTS.md / context files,
//     workspace tree) and the user's append text (APPEND_SYSTEM.md, --append)
//
// OMP's own harness instructions (role, tool policy, workflow) are left out:
// they describe OMP's agent loop, and two competing frameworks in one prompt
// make the model worse. User content is forwarded verbatim — no rewriting of
// names or paths — so requests stay an honest description of what is running.
//
// Markers come from OMP 18's prompts/system/{system,project}-prompt.md;
// tests/contract-omp-prompt.ts renders OMP's real builder and checks them.

import { MCP_TOOL_PREFIX } from "./skills.js";

export interface OmpPromptParts {
	personality?: string;
	skillsAndRules?: string;
	projectContext?: string;
	appendText?: string;
}

export interface ProjectionOptions {
	personality?: boolean;
	skills?: boolean;
	projectContext?: boolean;
	appendText?: boolean;
}

/** Text from `start` up to (not including) the first of `ends` found after it. */
function sliceSection(text: string, start: string, ends: string[]): string | undefined {
	const from = text.indexOf(start);
	if (from === -1) return undefined;
	let to = text.length;
	for (const end of ends) {
		const at = text.indexOf(end, from + start.length);
		if (at !== -1 && at < to) to = at;
	}
	const section = text.slice(from, to).trim();
	return section.length > start.length ? section : undefined;
}

export function extractOmpPromptParts(systemPrompt: string[] | string | undefined): OmpPromptParts {
	const blocks = Array.isArray(systemPrompt) ? systemPrompt : systemPrompt ? [systemPrompt] : [];
	const parts: OmpPromptParts = {};
	for (const block of blocks) {
		// Personality ends only at the next § section: PERSONALITY.md may use its own headings.
		parts.personality ??= sliceSection(block, "# Personality\n", ["\n§ "]);
		parts.skillsAndRules ??= sliceSection(block, "# Skills & Rules\n", ["\n§ ", "\n# "]);

		const ctxStart = block.indexOf("<project-context>");
		const ctxEnd = block.indexOf("</project-context>");
		if (parts.projectContext === undefined && ctxStart !== -1 && ctxEnd > ctxStart) {
			parts.projectContext = block.slice(ctxStart, ctxEnd + "</project-context>".length).trim();
			// The project block ends with OMP's <critical> reminders, then the
			// user's append text (APPEND_SYSTEM.md / --append-system-prompt).
			const tail = block.slice(ctxEnd + "</project-context>".length);
			const criticalEnd = tail.indexOf("</critical>");
			const append = (criticalEnd === -1 ? tail : tail.slice(criticalEnd + "</critical>".length)).trim();
			if (append) parts.appendText = append;
		}
	}
	return parts;
}

const READ_TOOL = `${MCP_TOOL_PREFIX}read`;

/** Compose the text appended to Claude Code's preset. Undefined when nothing applies. */
export function composeAppend(parts: OmpPromptParts, opts: ProjectionOptions = {}): string | undefined {
	const sections: string[] = [];
	if (opts.personality !== false && parts.personality) sections.push(parts.personality);
	if (opts.skills !== false && parts.skillsAndRules) {
		sections.push(
			`${parts.skillsAndRules}\n\n` +
			`Read \`skill://<name>\` and \`rule://<name>\` URIs with the \`${READ_TOOL}\` tool; it resolves them.`,
		);
	}
	if (opts.projectContext !== false && parts.projectContext) sections.push(parts.projectContext);
	if (opts.appendText !== false && parts.appendText) sections.push(parts.appendText);
	return sections.length ? sections.join("\n\n") : undefined;
}

/** True when the prompt is OMP's main agent prompt rather than a one-off (summary, title…). */
export function isAgentPrompt(systemPrompt: string[] | string | undefined): boolean {
	const blocks = Array.isArray(systemPrompt) ? systemPrompt : systemPrompt ? [systemPrompt] : [];
	return blocks.some((b) => b.includes("<project-context>"));
}
