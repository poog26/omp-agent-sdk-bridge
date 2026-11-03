// Model catalog + context-window policy for the /model picker.
//
// The picker is driven by OMP's own Anthropic catalog, so new Claude models show
// up when OMP updates, with no bridge release. Models with 1M included on every
// plan get one entry. Where the window is a real plan difference (plan-gated or
// unmeasured models), the unsuffixed id is the default window and the other gets
// a "-1m" / "-200k" suffix, so switching window is just picking the other entry.
//
// Deliberately free of runtime imports so tests can load it without OMP.

export type ContextWindowMode = "auto" | "1m" | "200k";
export type WindowKind = "1m" | "200k";

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	contextWindow: ContextWindowMode;
	/** Model ids pinned to a 200K default (bare id) — escape hatch for a model Claude Code won't serve at 1M. */
	forceTwoHundredK?: string[];
};

export type ClaudeCodeRuntimeModel = {
	/** Id passed to Claude Code (`--model`); may carry the `[1m]` suffix. */
	cliModelId: string;
	/** Window Claude Code serves for that id. */
	servedWindow: number;
};

export const TWO_HUNDRED_K_CONTEXT = 200_000;
export const ONE_M_CONTEXT = 1_000_000;

// --- Measured Claude Code (Agent SDK, claude.ai login) behavior ---
//
// - `[1m]` is the reliable way to request 1M; bare ids serve 200K.
// - An unentitled `[1m]` id is rejected outright (400/429) on every turn, so a
//   model only defaults to 1M once someone has measured that it works.
// Sources: pi-claude-bridge diag/CONTEXT-SIZE.md (through 2026-10-30) and the
// omp-claude-bridge 0.8 measurements.

/** `[1m]` measured to serve 1M on every plan. */
const MEASURED_ONE_M = new Set([
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-haiku-5-5",
]);

/** Bare id already serves 1M, and no 200K runtime exists. */
const BARE_IS_ONE_M = new Set(["claude-opus-4-7"]);

/** `[1m]` works, but only on some plans. */
const PLAN_GATED_ONE_M: Record<string, (s: LongContextSettings) => boolean> = {
	// 1M on Max / Extra Usage; 429 on Pro without it.
	"claude-opus-4-6": (s) => s.plan === "max" || s.longContextExtraUsage,
	// 1M with Extra Usage only.
	"claude-sonnet-4-6": (s) => s.longContextExtraUsage,
};

/** Is a 1M runtime known or plausible (catalog says 1M) for this model? */
function hasOneMRuntime(id: string, catalogWindow: number | undefined): boolean {
	return MEASURED_ONE_M.has(id) || BARE_IS_ONE_M.has(id) || id in PLAN_GATED_ONE_M || (catalogWindow ?? 0) >= ONE_M_CONTEXT;
}

export function runtimeFor(id: string, kind: WindowKind, catalogWindow?: number): ClaudeCodeRuntimeModel | null {
	if (kind === "200k") {
		return BARE_IS_ONE_M.has(id) ? null : { cliModelId: id, servedWindow: TWO_HUNDRED_K_CONTEXT };
	}
	if (BARE_IS_ONE_M.has(id)) return { cliModelId: id, servedWindow: ONE_M_CONTEXT };
	return hasOneMRuntime(id, catalogWindow) ? { cliModelId: `${id}[1m]`, servedWindow: ONE_M_CONTEXT } : null;
}

/** Window the unsuffixed id should use under the current settings. */
export function defaultWindowFor(id: string, settings: LongContextSettings, catalogWindow?: number): WindowKind {
	const available = (k: WindowKind) => runtimeFor(id, k, catalogWindow) != null;
	let preferred: WindowKind;
	if (settings.forceTwoHundredK?.includes(id)) preferred = "200k";
	else if (settings.contextWindow !== "auto") preferred = settings.contextWindow;
	else if (MEASURED_ONE_M.has(id) || BARE_IS_ONE_M.has(id)) preferred = "1m";
	else if (PLAN_GATED_ONE_M[id]) preferred = PLAN_GATED_ONE_M[id](settings) ? "1m" : "200k";
	else preferred = "200k"; // unmeasured: safe default
	if (available(preferred)) return preferred;
	return preferred === "1m" ? "200k" : "1m";
}

// --- Effective window ---
//
// Claude Code refuses a request locally (no API call) once the context reaches
// window − min(maxOutputTokens, 20000) − 3000: 977K on 1M, 177K on 200K.
// Registering the served window would let OMP's auto-compaction fire after that
// point, so every long session ended in "Prompt is too long". Register the
// usable window instead; the picker label still names the served one.
export function effectiveWindow(servedWindow: number, maxOutputTokens: number | undefined): number {
	return servedWindow - Math.min(maxOutputTokens ?? 20_000, 20_000) - 3_000;
}

// --- Catalog projection ---

/** OMP ships dated snapshot ids beside bare ids; never show them. */
function isDatedAlias(id: string): boolean {
	return /-20\d{6}$/.test(id);
}

const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

/** claude-opus-4-7 → { family: "opus", tuple: [4, 7] } */
export function versionRank(id: string): { family: string; tuple: [number, number] } {
	const [, family = "", major, minor] = id.split("-");
	return { family, tuple: [Number(major) || 0, Number(minor) || 0] };
}

function compareModels(a: string, b: string): number {
	const fa = FAMILY_ORDER.indexOf(versionRank(a).family);
	const fb = FAMILY_ORDER.indexOf(versionRank(b).family);
	const ta = fa === -1 ? FAMILY_ORDER.length : fa;
	const tb = fb === -1 ? FAMILY_ORDER.length : fb;
	if (ta !== tb) return ta - tb;
	const [ra, rb] = [versionRank(a).tuple, versionRank(b).tuple];
	if (ra[0] !== rb[0]) return rb[0] - ra[0];
	if (ra[1] !== rb[1]) return rb[1] - ra[1];
	return a.localeCompare(b);
}

/** Models hidden unless the user opts in: not generally served to claude.ai plans. */
export const DEFAULT_EXCLUDED_MODELS = ["mythos"];

export function buildModels<T extends { id: string; [key: string]: any }>(
	catalog: T[],
	exclude: string[] = DEFAULT_EXCLUDED_MODELS,
) {
	return catalog
		.filter((m) => typeof m.id === "string" && m.id.startsWith("claude-") && !isDatedAlias(m.id))
		.filter((m) => !exclude.some((pattern) => pattern && m.id.includes(pattern)))
		.sort((a, b) => compareModels(a.id, b.id))
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinking, thinkingLevelMap, cost }) => ({
			id,
			name: name as string,
			reasoning, input, contextWindow: contextWindow as number, maxTokens: maxTokens as number,
			...(thinking ? { thinking } : {}),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			// OMP's list prices, the same ones every other model's footer and stats use. Your
			// plan doesn't bill per token, so this is the API-equivalent cost of the usage.
			cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

// --- Picker variants ---

/** Split a registered id into base id + forced window. Base ids never end in these suffixes. */
export function parseVariantId(id: string): { baseId: string; forced?: WindowKind } {
	if (id.endsWith("-1m")) return { baseId: id.slice(0, -3), forced: "1m" };
	if (id.endsWith("-200k")) return { baseId: id.slice(0, -5), forced: "200k" };
	return { baseId: id };
}

function variantName(baseName: string, servedWindow: number): string {
	const label = servedWindow >= ONE_M_CONTEXT ? "1M" : "200K";
	const base = baseName.replace(/\s*(?:\((?:1M|200K)\)|\b1M\b)\s*$/i, "").trimEnd();
	return `${base} (${label})`;
}

export function buildVariantModels<T extends { id: string; name: string; contextWindow: number; maxTokens: number }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	const result: T[] = [];
	for (const m of models) {
		const defaultKind = defaultWindowFor(m.id, settings, m.contextWindow);
		const kinds: WindowKind[] = [defaultKind, defaultKind === "1m" ? "200k" : "1m"];
		// Where 1M is included on every plan, a 200K entry would only compact earlier,
		// which OMP's own compaction threshold already controls. Offer the second
		// window only where it is a real plan/entitlement difference: plan-gated
		// models, and unmeasured ones whose 1M support is still unknown.
		if (MEASURED_ONE_M.has(m.id) || BARE_IS_ONE_M.has(m.id)) kinds.length = 1;
		for (const kind of kinds) {
			const runtime = runtimeFor(m.id, kind, m.contextWindow);
			if (!runtime) continue;
			result.push({
				...m,
				id: kind === defaultKind ? m.id : `${m.id}-${kind}`,
				name: variantName(m.name, runtime.servedWindow),
				contextWindow: effectiveWindow(runtime.servedWindow, m.maxTokens),
			});
		}
	}
	return result;
}

/** Runtime for a registered (possibly suffixed) picker id. */
export function resolveRuntime(registeredId: string, settings: LongContextSettings, catalogWindow?: number): ClaudeCodeRuntimeModel {
	const { baseId, forced } = parseVariantId(registeredId);
	const kind = forced ?? defaultWindowFor(baseId, settings, catalogWindow);
	const runtime = runtimeFor(baseId, kind, catalogWindow);
	if (!runtime) throw new Error(`claude-bridge: model ${registeredId} has no Claude Code runtime for a ${kind} window`);
	return runtime;
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings, catalogWindow?: number): string {
	return resolveRuntime(model.id, settings, catalogWindow).cliModelId;
}

/** Exact match first, then the newest partial match ("opus" → newest Opus). */
export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	const exact = models.find((m) => m.id === lower);
	if (exact) return exact;
	const candidates = models.filter((m) => m.id.includes(lower));
	if (!candidates.length) return undefined;
	return candidates.reduce((best, m) => {
		const [a, b] = [versionRank(m.id).tuple, versionRank(best.id).tuple];
		const newer = a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
		return newer ? m : best;
	});
}
