// Usage ledger: one JSON line per request Claude Code makes for the bridge — conversation
// turns, compaction/title one-shots, cache-warm refreshes, AskClaude — so plan usage the
// bridge causes is visible and wasted usage is caught where it happens.
//
// Two kinds of waste are checked on every request:
//   - A cache miss inside the cache lifetime: the request re-wrote context the previous
//     request had cached. Each one is recorded with the likeliest cause and whether it
//     was expected (OMP rewrote the history) or not.
//   - Unattributed usage: Claude Code's own per-query total is larger than the requests
//     the bridge saw streamed, i.e. Claude Code spent tokens on calls the bridge can't see.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { dirname } from "path";

export type CallKind = "turn" | "one-shot" | "warm" | "askclaude" | "unattributed";
/** How the bridge prepared Claude Code's session for a turn; "in-query" is a request after a tool result. */
export type SyncPath = "reuse" | "extend" | "rebuild" | "clean-start" | "in-query" | "continuation";

export interface CallTokens {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

/** Hashes of what makes up the cached prefix, to name the cause of a miss. */
export interface Fingerprint {
	system: string;
	tools: string;
	thinking: string;
}

export interface Miss {
	/** Prompt tokens that should have been read from the cache but were written again. */
	lost: number;
	cause: string;
	/** True when the miss follows from something OMP did on purpose (compaction, /tree). */
	expected: boolean;
}

export interface LedgerEntry extends CallTokens {
	/** When the request started, ms since epoch. */
	ts: number;
	kind: CallKind;
	model: string;
	/** Short OMP session key, for telling conversations apart. */
	session?: string;
	sync?: SyncPath;
	aborted?: boolean;
	miss?: Miss;
}

export interface PrevCall {
	endedAt: number;
	prompt: number;
	model: string;
	fingerprint?: Fingerprint;
}

export interface CallInfo {
	startedAt: number;
	model: string;
	tokens: CallTokens;
	fingerprint?: Fingerprint;
	sync?: SyncPath;
	/** OMP rewrote the history since the previous request (compaction, /tree). */
	historyRewritten?: boolean;
}

/** Misses smaller than this are noise (a short tail, a tool result) rather than waste. */
export const MIN_LOST_TOKENS = 2048;

export function zeroTokens(): CallTokens {
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export function promptTokens(t: CallTokens): number {
	return t.input + t.cacheRead + t.cacheWrite;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Tokens from an Anthropic usage object (message_start, message_delta, a result's usage). */
export function tokensFromReport(report: unknown, into: CallTokens = zeroTokens()): CallTokens {
	if (!report || typeof report !== "object") return into;
	const r = report as Record<string, unknown>;
	into.input = count(r.input_tokens) ?? into.input;
	into.cacheRead = count(r.cache_read_input_tokens) ?? into.cacheRead;
	into.cacheWrite = count(r.cache_creation_input_tokens) ?? into.cacheWrite;
	into.output = count(r.output_tokens) ?? into.output;
	return into;
}

/**
 * Whether a request lost a cached prefix it should have read, and why. Undefined when it
 * read what it should have, when the previous request is too old for its cache entry to
 * be alive, or when the model differs (each model has its own cache).
 */
export function detectMiss(prev: PrevCall | undefined, cur: CallInfo, ttlSeconds: number): Miss | undefined {
	if (!prev || prev.model !== cur.model) return undefined;
	// A little slack: the entry's clock starts when the previous request was processed.
	if ((cur.startedAt - prev.endedAt) / 1000 > ttlSeconds - 15) return undefined;
	const shared = Math.min(prev.prompt, promptTokens(cur.tokens));
	const lost = shared - cur.tokens.cacheRead;
	if (lost < MIN_LOST_TOKENS || cur.tokens.cacheRead >= 0.8 * shared) return undefined;

	if (cur.historyRewritten) return { lost, cause: "OMP rewrote the history (compaction or /tree)", expected: true };
	const before = prev.fingerprint;
	const now = cur.fingerprint;
	if (before && now) {
		if (before.tools !== now.tools) return { lost, cause: "OMP's tool list changed", expected: false };
		if (before.system !== now.system) return { lost, cause: "the system prompt changed (persona, skills, rules or project context)", expected: false };
		if (before.thinking !== now.thinking) return { lost, cause: "thinking settings changed", expected: false };
	}
	if (cur.sync === "rebuild") return { lost, cause: "the bridge rebuilt Claude Code's session from OMP's history", expected: false };
	return { lost, cause: "unexplained: the prefix should have been cached", expected: false };
}

/**
 * Follows the requests of one Claude Code query from its stream events. A request runs
 * from message_start to message_stop; one cut off before message_stop (abort, error) is
 * still counted when the query ends.
 */
export class QueryMeter {
	private call: { startedAt: number; tokens: CallTokens } | undefined;
	private calls = 0;
	/** Everything the bridge saw streamed in this query. */
	readonly observed: CallTokens = zeroTokens();

	constructor(private readonly onCall: (index: number, startedAt: number, tokens: CallTokens, aborted: boolean) => void) {}

	/** Feed every stream event of the query. */
	event(event: unknown): void {
		if (!event || typeof event !== "object") return;
		const e = event as { type?: unknown; message?: { usage?: unknown }; usage?: unknown };
		if (e.type === "message_start") {
			if (this.call) this.finish(true);
			this.call = { startedAt: Date.now(), tokens: tokensFromReport(e.message?.usage) };
		} else if (e.type === "message_delta" && this.call) {
			tokensFromReport(e.usage, this.call.tokens);
		} else if (e.type === "message_stop" && this.call) {
			this.finish(false);
		}
	}

	/** End of the query: a request still open was cut off. */
	close(): void {
		if (this.call) this.finish(true);
	}

	/**
	 * Tokens in Claude Code's per-query total (a result message's `usage`) beyond what was
	 * streamed, or undefined when everything is accounted for.
	 */
	unattributed(resultUsage: unknown): CallTokens | undefined {
		if (!resultUsage || typeof resultUsage !== "object") return undefined;
		const total = tokensFromReport(resultUsage);
		const extra: CallTokens = {
			input: Math.max(0, total.input - this.observed.input),
			cacheRead: Math.max(0, total.cacheRead - this.observed.cacheRead),
			cacheWrite: Math.max(0, total.cacheWrite - this.observed.cacheWrite),
			output: Math.max(0, total.output - this.observed.output),
		};
		// A few tokens of slack: the last delta of an interrupted request can be dropped.
		return promptTokens(extra) + extra.output > 64 ? extra : undefined;
	}

	private finish(aborted: boolean): void {
		const call = this.call!;
		this.call = undefined;
		this.observed.input += call.tokens.input;
		this.observed.cacheRead += call.tokens.cacheRead;
		this.observed.cacheWrite += call.tokens.cacheWrite;
		this.observed.output += call.tokens.output;
		this.onCall(this.calls++, call.startedAt, call.tokens, aborted);
	}
}

// --- The ledger file ---

const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

/** Append one entry; the file rolls over to `<path>.1` past 8 MB. Never throws. */
export function appendLedger(path: string, entry: LedgerEntry): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path) && statSync(path).size > MAX_LEDGER_BYTES) renameSync(path, `${path}.1`);
		appendFileSync(path, JSON.stringify(entry) + "\n");
	} catch { /* the ledger must never take a turn down */ }
}

/** Entries from `sinceMs` on, oldest first, including the rolled-over file. */
export function readLedger(path: string, sinceMs = 0): LedgerEntry[] {
	const entries: LedgerEntry[] = [];
	for (const file of [`${path}.1`, path]) {
		let text: string;
		try { text = readFileSync(file, "utf-8"); } catch { continue; }
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as LedgerEntry;
				if (entry.ts >= sinceMs) entries.push(entry);
			} catch { /* a torn last line from a crash */ }
		}
	}
	return entries;
}

// --- Report ---

export interface KindTotals extends CallTokens {
	requests: number;
}

export interface LedgerSummary {
	byKind: Partial<Record<CallKind, KindTotals>>;
	/** Share of conversation prompt tokens read from the cache. */
	hitRate: number | undefined;
	misses: LedgerEntry[];
	expectedMisses: LedgerEntry[];
	lostTokens: number;
}

export function summarizeLedger(entries: LedgerEntry[]): LedgerSummary {
	const byKind: LedgerSummary["byKind"] = {};
	const misses: LedgerEntry[] = [];
	const expectedMisses: LedgerEntry[] = [];
	for (const e of entries) {
		const t = (byKind[e.kind] ??= { requests: 0, ...zeroTokens() });
		t.requests++;
		t.input += e.input;
		t.cacheRead += e.cacheRead;
		t.cacheWrite += e.cacheWrite;
		t.output += e.output;
		if (e.miss) (e.miss.expected ? expectedMisses : misses).push(e);
	}
	const turns = byKind.turn;
	const prompt = turns ? promptTokens(turns) : 0;
	return {
		byKind,
		hitRate: prompt > 0 ? turns!.cacheRead / prompt : undefined,
		misses,
		expectedMisses,
		lostTokens: misses.reduce((sum, e) => sum + e.miss!.lost, 0),
	};
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}K`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
	return String(n);
}

const KIND_LABELS: Record<CallKind, string> = {
	turn: "conversation",
	"one-shot": "compaction/titles",
	warm: "cache refresh",
	askclaude: "AskClaude",
	unattributed: "UNSEEN by bridge",
};

export function formatReport(summary: LedgerSummary, hours: number, ledgerPath: string): string[] {
	const lines = [`Claude bridge usage, last ${hours}h`];
	const kinds = Object.keys(summary.byKind) as CallKind[];
	if (!kinds.length) return [...lines, "  no requests recorded", `  ledger: ${ledgerPath}`];
	for (const kind of kinds) {
		const t = summary.byKind[kind]!;
		lines.push(`  ${KIND_LABELS[kind].padEnd(18)} ${String(t.requests).padStart(5)} req  ` +
			`read ${formatTokens(t.cacheRead).padStart(6)}  write ${formatTokens(t.cacheWrite).padStart(6)}  ` +
			`in ${formatTokens(t.input).padStart(5)}  out ${formatTokens(t.output).padStart(6)}`);
	}
	if (summary.hitRate !== undefined) lines.push(`  conversation cache hit rate: ${(summary.hitRate * 100).toFixed(1)}%`);
	if (summary.byKind.unattributed) {
		lines.push("  WARNING: Claude Code reported usage the bridge never saw streamed (see 'UNSEEN' above).");
	}
	if (summary.misses.length) {
		lines.push(`  cache misses inside the cache lifetime: ${summary.misses.length}, ${formatTokens(summary.lostTokens)} tokens re-written`);
		for (const e of [...summary.misses].sort((a, b) => b.miss!.lost - a.miss!.lost).slice(0, 8)) {
			lines.push(`    ${new Date(e.ts).toLocaleString()}  ${e.model}  ${formatTokens(e.miss!.lost)}  ${e.miss!.cause}`);
		}
	} else {
		lines.push("  no unexpected cache misses");
	}
	if (summary.expectedMisses.length) {
		const lost = summary.expectedMisses.reduce((sum, e) => sum + e.miss!.lost, 0);
		lines.push(`  expected re-writes after compaction or /tree: ${summary.expectedMisses.length} (${formatTokens(lost)} tokens)`);
	}
	lines.push(`  ledger: ${ledgerPath}`);
	return lines;
}
