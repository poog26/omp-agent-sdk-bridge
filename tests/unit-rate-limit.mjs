import test from "node:test";
import assert from "node:assert/strict";

import { explainClaudeError, explainPlanLimit, formatResetsAt, isExtraUsage, newRateLimitTracker, rateLimitNotice } from "../src/rate-limit.ts";

// SDKRateLimitInfo units: utilization is a fraction 0..1, resetsAt is Unix seconds.
const inAnHour = Math.floor(Date.now() / 1000) + 3600;

test("allowed_warning below 80% stays silent (utilization is a fraction)", () => {
	const t = newRateLimitTracker();
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.01 }, t, "claude-bridge"), null);
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.79 }, t, "claude-bridge"), null);
});

test("allowed_warning at 80%+ warns once per 5% step", () => {
	const t = newRateLimitTracker();
	const first = rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.81, resetsAt: inAnHour }, t, "claude-bridge");
	assert.match(first.message, /5-hour usage at 81%/);
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.83 }, t, "claude-bridge"), null, "same step");
	assert.match(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.86 }, t, "claude-bridge").message, /86%/);
	// Back to allowed re-arms the warning.
	rateLimitNotice({ status: "allowed" }, t, "claude-bridge");
	assert.ok(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.81 }, t, "claude-bridge"));
});

test("rejected surfaces as an error with a real reset time (seconds, not 1970)", () => {
	const n = rateLimitNotice({ status: "rejected", rateLimitType: "seven_day", resetsAt: inAnHour }, newRateLimitTracker(), "claude-bridge");
	assert.equal(n.level, "error");
	assert.match(n.message, /weekly limit reached/);
	assert.doesNotMatch(n.message, /1970|unknown/);
});

test("Extra Usage billing is announced once until usage is back under the plan", () => {
	const t = newRateLimitTracker();
	const info = { status: "allowed", rateLimitType: "five_hour", isUsingOverage: true, resetsAt: inAnHour };
	assert.ok(isExtraUsage(info));
	assert.match(rateLimitNotice(info, t, "claude-bridge").message, /billed to Extra Usage/);
	assert.equal(rateLimitNotice(info, t, "claude-bridge"), null);
	rateLimitNotice({ status: "allowed" }, t, "claude-bridge");
	assert.ok(rateLimitNotice(info, t, "claude-bridge"));
});

test("formatResetsAt handles missing values", () => {
	assert.equal(formatResetsAt(undefined), "unknown");
	assert.ok(formatResetsAt(inAnHour).length > 0);
});

test("explainClaudeError adds guidance for Extra Usage and login failures, passes others through", () => {
	assert.match(explainClaudeError("400 Third-party apps now draw from your extra usage"), /does not try to avoid/);
	assert.match(explainClaudeError("Not logged in · Please run /login"), /Claude Code's own login/);
	assert.equal(explainClaudeError("boom"), "boom");
});

test("late Claude limit events stay silent on Codex and resume when switching back", () => {
	const tracker = newRateLimitTracker();
	const rejected = { status: "rejected", rateLimitType: "five_hour", resetsAt: inAnHour };
	let provider = "claude-bridge";
	assert.match(rateLimitNotice(rejected, tracker, provider).message, /Claude 5-hour limit reached/);
	provider = "openai-codex";
	assert.equal(rateLimitNotice(rejected, tracker, provider), null);
	assert.equal(rateLimitNotice(rejected, tracker, undefined), null);
	provider = "claude-bridge";
	assert.match(rateLimitNotice(rejected, tracker, provider).message, /Claude 5-hour limit reached/);
});

test("hidden background warnings do not suppress later visible warnings or the billing guard", () => {
	for (const info of [
		{ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.85 },
		{ status: "allowed", rateLimitType: "five_hour", isUsingOverage: true },
	]) {
		const tracker = newRateLimitTracker();
		assert.equal(rateLimitNotice(info, tracker, "openai-codex"), null);
		assert.equal(isExtraUsage(info), info.isUsingOverage === true);
		assert.ok(rateLimitNotice(info, tracker, "claude-bridge"));
		assert.equal(rateLimitNotice(info, tracker, "claude-bridge"), null);
	}
});

test("warning steps are independent for every window and reset period", () => {
	const tracker = newRateLimitTracker();
	const fiveHour = { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: inAnHour };
	const weekly = { ...fiveHour, rateLimitType: "seven_day", utilization: 0.81 };
	assert.ok(rateLimitNotice(fiveHour, tracker, "claude-bridge"));
	assert.ok(rateLimitNotice(weekly, tracker, "claude-bridge"), "weekly warning must not inherit 5-hour step");
	assert.equal(rateLimitNotice(weekly, tracker, "claude-bridge"), null);
	rateLimitNotice({ status: "allowed", rateLimitType: "five_hour", resetsAt: inAnHour }, tracker, "claude-bridge");
	assert.equal(rateLimitNotice(weekly, tracker, "claude-bridge"), null, "another window returning to allowed does not re-arm weekly");
	assert.ok(rateLimitNotice({ ...weekly, resetsAt: inAnHour + 604800 }, tracker, "claude-bridge"), "a new weekly period re-arms without an allowed event");
});

test("Extra Usage notices are independent for every window and reset period", () => {
	const tracker = newRateLimitTracker();
	const fiveHour = { status: "allowed", rateLimitType: "five_hour", isUsingOverage: true, resetsAt: inAnHour };
	const weekly = { ...fiveHour, rateLimitType: "seven_day" };
	assert.match(rateLimitNotice(fiveHour, tracker, "claude-bridge").message, /billed to Extra Usage/);
	assert.match(rateLimitNotice(weekly, tracker, "claude-bridge").message, /billed to Extra Usage/);
	assert.equal(rateLimitNotice(weekly, tracker, "claude-bridge"), null);
	rateLimitNotice({ status: "allowed", rateLimitType: "five_hour", resetsAt: inAnHour }, tracker, "claude-bridge");
	assert.equal(rateLimitNotice(weekly, tracker, "claude-bridge"), null);
	const nextPeriod = { ...weekly, resetsAt: inAnHour + 604800 };
	assert.equal(rateLimitNotice(nextPeriod, tracker, "openai-codex"), null);
	assert.ok(rateLimitNotice(nextPeriod, tracker, "claude-bridge"), "hidden events do not consume the new period");
	assert.equal(rateLimitNotice(nextPeriod, tracker, "claude-bridge"), null);
});

test("a session-limit error gains the reset hint OMP can classify and time-parse", () => {
	// The exact text Claude Code returned on 2026-11-20; OMP could neither classify
	// "session limit" nor parse "resets 4am (Europe/Budapest)", so the turn failed
	// instead of waiting for the reset.
	const observed = "You've hit your session limit · resets 4am (Europe/Budapest)";
	const resetsAtMs = Date.now() + 48 * 60_000;
	const msg = explainPlanLimit(observed, resetsAtMs, new Date());
	assert.match(msg, /^You've hit your session limit/);
	assert.match(msg, /Claude usage limit reached — resets in ~48 min/);
	assert.match(msg, /reset at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
	// Idempotent: wrapping again (e.g. at both the capture and the failTurn site) adds nothing.
	assert.equal(explainPlanLimit(msg, resetsAtMs), msg);
});

test("plan-limit errors without a usable reset still classify for OMP", () => {
	const extraUsageStop = "Stopped: your Claude plan limit is reached and this request was billed to Extra Usage.";
	for (const resetsAtMs of [undefined, Date.now() - 60_000]) {
		const msg = explainPlanLimit(extraUsageStop, resetsAtMs, new Date());
		assert.match(msg, /Claude usage limit reached — wait for the plan window to reset, then retry\./);
		assert.doesNotMatch(msg, /~\d+ min/);
	}
});

test("errors that are not plan limits pass through unchanged", () => {
	const msg = "Unexpected EOF while reading the stream";
	assert.equal(explainPlanLimit(msg, Date.now() + 3_600_000, new Date()), msg);
});
