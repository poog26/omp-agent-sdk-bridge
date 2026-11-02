// OMP thinking level → Claude Code effort / thinking settings.
//
// OMP 18 describes each model's thinking support as `thinking: { mode, efforts }`.
// The requested level is clamped to the highest level the model supports, so
// e.g. xhigh on Sonnet 4.6 (low/medium/high) sends high rather than a value
// Claude Code would reject or silently remap.

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

const CC_EFFORTS: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];
const OMP_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface ThinkingModel {
	reasoning?: boolean;
	thinking?: { mode?: string; efforts?: readonly string[] };
	thinkingLevelMap?: Record<string, string | null | undefined>;
}

export interface ThinkingRequest {
	reasoning?: string;
	disableReasoning?: boolean;
	forceReasoningOff?: boolean;
	hideThinkingSummary?: boolean;
}

export interface ThinkingPlan {
	effort?: ClaudeEffort;
	/** Explicitly turn thinking off (OMP "off", side calls that disable reasoning). */
	disabled?: boolean;
	/** thinking.display; only meaningful when thinking runs. */
	display?: "summarized" | "omitted";
}

function rank(level: string): number {
	return OMP_LEVELS.indexOf(level);
}

/** Effort-capable modes; pure budget-mode models (Haiku/Sonnet 4.5) keep Claude Code's default. */
function supportsEffort(model: ThinkingModel): boolean {
	const mode = model.thinking?.mode;
	if (!mode) return true; // pre-18 catalogs: no metadata, trust the level
	return mode.includes("adaptive") || mode.includes("effort");
}

export function effortFor(model: ThinkingModel, reasoning: string | undefined): ClaudeEffort | undefined {
	if (!reasoning || rank(reasoning) === -1 || !supportsEffort(model)) return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning];
	if (mapped === null) return undefined;
	if (typeof mapped === "string" && (CC_EFFORTS as string[]).includes(mapped)) return mapped as ClaudeEffort;

	const requested = reasoning === "minimal" ? "low" : reasoning;
	const supported = (model.thinking?.efforts ?? CC_EFFORTS).filter((e): e is ClaudeEffort => (CC_EFFORTS as string[]).includes(e));
	if (!supported.length) return undefined;
	const fitting = supported.filter((e) => rank(e) <= rank(requested));
	// Requested below everything supported: use the lowest supported level.
	return fitting.length ? fitting.reduce((a, b) => (rank(b) > rank(a) ? b : a)) : supported.reduce((a, b) => (rank(b) < rank(a) ? b : a));
}

export function planThinking(model: ThinkingModel, req: ThinkingRequest): ThinkingPlan {
	if (req.disableReasoning || req.forceReasoningOff || req.reasoning === "off") return { disabled: true };
	const effort = effortFor(model, req.reasoning);
	if (!effort) return {};
	// Opus 4.7+ default thinking.display to "omitted"; ask for summaries unless OMP hides them anyway.
	return { effort, display: req.hideThinkingSummary ? "omitted" : "summarized" };
}
