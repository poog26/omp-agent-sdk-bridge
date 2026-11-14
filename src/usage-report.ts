// Feeds OMP's Usage panel (/usage) for the claude-bridge provider.
//
// The figures come only from what Claude Code itself reports through the Agent SDK:
// each `rate_limit_event` (see recordRateLimit for which fields) and
// `Query.accountInfo()` for the account label. The bridge never
// reads Claude Code's login to ask Anthropic's usage endpoint itself, so the panel
// shows what was reported during the last Claude turn rather than polling live.
//
// The state is kept in a small JSON file (percentages, reset times, the account's
// email and plan name; nothing secret) so the panel survives an OMP restart.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface ObservedWindow {
	/** Fraction used, 0..1, as Claude Code reports it. */
	utilization: number;
	/** Unix seconds. */
	resetsAt?: number;
	status?: string;
	/** Epoch ms when Claude Code reported it. */
	seenAt: number;
}

export interface UsageState {
	windows: Record<string, ObservedWindow>;
	account?: { email?: string; subscriptionType?: string };
}

export interface ReportedRateLimit {
	status?: string;
	rateLimitType?: string;
	utilization?: number;
	resetsAt?: number;
}

const HOUR_MS = 3_600_000;
const WINDOWS: Record<string, { label: string; windowId: string; durationMs?: number; tier?: string }> = {
	five_hour: { label: "5 hours", windowId: "5h", durationMs: 5 * HOUR_MS },
	seven_day: { label: "7 days", windowId: "7d", durationMs: 7 * 24 * HOUR_MS },
	seven_day_overage_included: { label: "7 days", windowId: "7d", durationMs: 7 * 24 * HOUR_MS },
	seven_day_opus: { label: "7 days (Opus)", windowId: "7d", durationMs: 7 * 24 * HOUR_MS, tier: "opus" },
	seven_day_sonnet: { label: "7 days (Sonnet)", windowId: "7d", durationMs: 7 * 24 * HOUR_MS, tier: "sonnet" },
	overage: { label: "Extra Usage", windowId: "extra" },
};
// Display order in the panel.
const ORDER = ["five_hour", "seven_day", "seven_day_overage_included", "seven_day_opus", "seven_day_sonnet", "overage"];

export function emptyUsageState(): UsageState {
	return { windows: {} };
}

function isFraction(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Record one rate_limit_event. Returns true when the state changed.
 *
 * The documented fields name one window and carry `utilization` only once usage
 * nears a threshold; below that an event says just `status: "allowed"`. Claude Code
 * also includes a per-window breakdown (`unifiedWindows`) that the SDK's types don't
 * declare yet. It is read here as optional display data only: absent or reshaped,
 * the panel just shows less, and nothing else (billing, Extra Usage, stopping a
 * turn) ever depends on it. The documented fields win for the window they name.
 */
export function recordRateLimit(state: UsageState, info: ReportedRateLimit | undefined, now = Date.now()): boolean {
	if (!info) return false;
	let changed = false;
	const breakdown = (info as { unifiedWindows?: unknown }).unifiedWindows;
	if (breakdown && typeof breakdown === "object") {
		for (const [type, window] of Object.entries(breakdown as Record<string, unknown>)) {
			const w = window as { utilization?: unknown; resetsAt?: unknown } | null;
			if (!w || !isFraction(w.utilization)) continue;
			state.windows[type] = {
				utilization: w.utilization,
				...(isFraction(w.resetsAt) ? { resetsAt: w.resetsAt } : {}),
				seenAt: now,
			};
			changed = true;
		}
	}
	if (info.rateLimitType && isFraction(info.utilization)) {
		state.windows[info.rateLimitType] = {
			utilization: info.utilization,
			...(isFraction(info.resetsAt) ? { resetsAt: info.resetsAt } : {}),
			...(info.status ? { status: info.status } : {}),
			seenAt: now,
		};
		changed = true;
	}
	return changed;
}

/**
 * Record Claude Code's account label. A different known email invalidates old
 * account-bound windows, but observations from the query requesting accountInfo
 * may have arrived first and must survive its asynchronous response.
 */
export function recordAccount(
	state: UsageState,
	info: { email?: string; subscriptionType?: string; apiProvider?: string } | undefined,
	observationsSince?: number,
): boolean {
	if (!info || (info.apiProvider && info.apiProvider !== "firstParty")) return false;
	const changedIdentity = !!state.account?.email && !!info.email
		&& state.account.email.toLowerCase() !== info.email.toLowerCase();
	const next = {
		...(!changedIdentity ? state.account : {}),
		...(info.email ? { email: info.email } : {}),
		...(info.subscriptionType ? { subscriptionType: info.subscriptionType } : {}),
	};
	if (JSON.stringify(next) === JSON.stringify(state.account ?? {})) return false;
	if (changedIdentity) {
		for (const [type, window] of Object.entries(state.windows)) {
			if (observationsSince === undefined || window.seenAt < observationsSince) delete state.windows[type];
		}
	}
	state.account = next;
	return true;
}

function statusFor(usedFraction: number): "ok" | "warning" | "exhausted" {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function ago(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Build the OMP UsageReport, or null when Claude Code hasn't reported anything yet. */
export function buildUsageReport(provider: string, state: UsageState, now = Date.now()) {
	const types = Object.keys(state.windows).sort((a, b) => {
		const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
		return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
	});
	if (!types.length) return null;
	const limits = [];
	let latest = 0;
	for (const type of types) {
		const seen = state.windows[type];
		latest = Math.max(latest, seen.seenAt);
		const meta = WINDOWS[type] ?? { label: type, windowId: type };
		// A window that has reset since Claude Code last reported it starts again from zero.
		const reset = seen.resetsAt !== undefined && seen.resetsAt * 1000 <= now;
		const used = reset ? 0 : Math.min(Math.max(seen.utilization, 0), 1);
		limits.push({
			id: `${provider}:${type}`,
			label: meta.label,
			scope: {
				provider,
				windowId: meta.windowId,
				...(meta.tier ? { tier: meta.tier } : {}),
				...(meta.tier ? {} : { shared: true }),
			},
			window: {
				id: meta.windowId,
				label: meta.label,
				...(meta.durationMs ? { durationMs: meta.durationMs } : {}),
				...(!reset && seen.resetsAt !== undefined ? { resetsAt: seen.resetsAt * 1000 } : {}),
			},
			amount: {
				used: used * 100,
				limit: 100,
				remaining: Math.max(0, 100 - used * 100),
				usedFraction: used,
				remainingFraction: Math.max(0, 1 - used),
				unit: "percent" as const,
			},
			status: statusFor(used),
		});
	}
	const plan = state.account?.subscriptionType;
	const email = state.account?.email;
	return {
		provider,
		fetchedAt: latest,
		limits,
		notes: [`As Claude Code reported it during your last Claude turn (${ago(now - latest)}); it updates with each turn.`],
		metadata: {
			source: "claude-code-rate-limit-events",
			...(email ? { email: plan ? `${email} (${plan})` : email } : {}),
		},
	};
}

export function loadUsageState(path: string): UsageState {
	try {
		if (!existsSync(path)) return emptyUsageState();
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || typeof parsed.windows !== "object") return emptyUsageState();
		return { windows: parsed.windows ?? {}, ...(parsed.account ? { account: parsed.account } : {}) };
	} catch {
		return emptyUsageState();
	}
}

export function saveUsageState(path: string, state: UsageState): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(state));
		renameSync(tmp, path);
	} catch {
		// Display-only state: losing it just means the panel waits for the next turn.
	}
}
