// Rate-limit and Extra Usage notices from the SDK's rate_limit_event.
//
// Units (SDKRateLimitInfo): `utilization` is a fraction 0..1, `resetsAt` is Unix
// seconds. The SDK emits one event per request, so warnings are de-duplicated by
// 5% step and only re-armed when usage drops back to "allowed".

import { PROVIDER_ID } from "./convert.js";

export const RATE_LIMIT_WARN_THRESHOLD = 0.8;

export interface RateLimitInfo {
	status?: "allowed" | "allowed_warning" | "rejected" | string;
	rateLimitType?: string;
	utilization?: number;
	resetsAt?: number;
	isUsingOverage?: boolean;
	overageStatus?: string;
	overageDisabledReason?: string;
}

export interface RateLimitNotice {
	message: string;
	level: "info" | "warning" | "error";
}

export interface RateLimitTracker {
	lastWarnStep: number | null;
	extraUsageNotified: boolean;
}

export function newRateLimitTracker(): RateLimitTracker {
	return { lastWarnStep: null, extraUsageNotified: false };
}

const WINDOW_LABELS: Record<string, string> = {
	five_hour: "5-hour",
	seven_day: "weekly",
	seven_day_opus: "weekly Opus",
	seven_day_sonnet: "weekly Sonnet",
	seven_day_overage_included: "weekly",
	overage: "Extra Usage",
};

export function windowLabel(type: string | undefined): string {
	return (type && WINDOW_LABELS[type]) ?? type ?? "usage";
}

export function formatResetsAt(resetsAt: number | undefined, now: Date = new Date()): string {
	if (!resetsAt) return "unknown";
	const at = new Date(resetsAt * 1000);
	const sameDay = at.toDateString() === now.toDateString();
	return sameDay
		? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: at.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** True when this request is being served (and billed) as Extra Usage. */
export function isExtraUsage(info: RateLimitInfo | undefined): boolean {
	return info?.isUsingOverage === true;
}

export function rateLimitNotice(
	info: RateLimitInfo | undefined,
	tracker: RateLimitTracker,
	activeProvider: string | undefined,
	threshold: number = RATE_LIMIT_WARN_THRESHOLD,
): RateLimitNotice | null {
	// A parked query or background role can report after the user switches models.
	// Do not consume warning de-duplication state for a notice the user won't see.
	if (!info || activeProvider !== PROVIDER_ID) return null;
	const window = windowLabel(info.rateLimitType);
	if (isExtraUsage(info)) {
		if (tracker.extraUsageNotified) return null;
		tracker.extraUsageNotified = true;
		return {
			message: `Claude ${window} limit reached — requests are now billed to Extra Usage (plan limit resets ${formatResetsAt(info.resetsAt)})`,
			level: "warning",
		};
	}
	if (info.status === "rejected") {
		tracker.lastWarnStep = null;
		return { message: `Claude ${window} limit reached — resets ${formatResetsAt(info.resetsAt)}`, level: "error" };
	}
	if (info.status === "allowed") {
		tracker.lastWarnStep = null;
		tracker.extraUsageNotified = false;
		return null;
	}
	if (info.status === "allowed_warning") {
		const fraction = info.utilization ?? 0;
		if (fraction < threshold) return null;
		const step = Math.floor((fraction * 100) / 5);
		if (tracker.lastWarnStep !== null && step <= tracker.lastWarnStep) return null;
		tracker.lastWarnStep = step;
		return {
			message: `Claude ${window} usage at ${Math.round(fraction * 100)}% — resets ${formatResetsAt(info.resetsAt)}`,
			level: "warning",
		};
	}
	return null;
}

// Known API error texts that mean "this would be (or was refused as) Extra Usage".
const EXTRA_USAGE_ERROR = /extra usage|out of extra usage|third-party apps now draw/i;

/** Rewrites a Claude Code error into something actionable, or returns it unchanged. */
export function explainClaudeError(message: string): string {
	if (EXTRA_USAGE_ERROR.test(message)) {
		return `${message}\n\nAnthropic routed this request to Extra Usage. The bridge does not try to avoid that ` +
			`classification. Check claude.ai → Settings → Usage, wait for your plan window to reset, or use ` +
			`Claude Code directly for subscription work.`;
	}
	if (/not logged in|please run \/login|invalid api key|oauth token has expired/i.test(message)) {
		return `${message}\n\nThe bridge uses Claude Code's own login, not OMP's /login. Run \`claude\` in a terminal ` +
			`and type /login, then retry.`;
	}
	return message;
}
