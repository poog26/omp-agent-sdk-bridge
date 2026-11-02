import test from "node:test";
import assert from "node:assert/strict";

import { explainClaudeError, formatResetsAt, isExtraUsage, newRateLimitTracker, rateLimitNotice } from "../src/rate-limit.ts";

// SDKRateLimitInfo units: utilization is a fraction 0..1, resetsAt is Unix seconds.
const inAnHour = Math.floor(Date.now() / 1000) + 3600;

test("allowed_warning below 80% stays silent (utilization is a fraction)", () => {
	const t = newRateLimitTracker();
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.01 }, t), null);
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.79 }, t), null);
});

test("allowed_warning at 80%+ warns once per 5% step", () => {
	const t = newRateLimitTracker();
	const first = rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.81, resetsAt: inAnHour }, t);
	assert.match(first.message, /5-hour usage at 81%/);
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.83 }, t), null, "same step");
	assert.match(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.86 }, t).message, /86%/);
	// Back to allowed re-arms the warning.
	rateLimitNotice({ status: "allowed" }, t);
	assert.ok(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.81 }, t));
});

test("rejected surfaces as an error with a real reset time (seconds, not 1970)", () => {
	const n = rateLimitNotice({ status: "rejected", rateLimitType: "seven_day", resetsAt: inAnHour }, newRateLimitTracker());
	assert.equal(n.level, "error");
	assert.match(n.message, /weekly limit reached/);
	assert.doesNotMatch(n.message, /1970|unknown/);
});

test("Extra Usage billing is announced once until usage is back under the plan", () => {
	const t = newRateLimitTracker();
	const info = { status: "allowed", rateLimitType: "five_hour", isUsingOverage: true, resetsAt: inAnHour };
	assert.ok(isExtraUsage(info));
	assert.match(rateLimitNotice(info, t).message, /billed to Extra Usage/);
	assert.equal(rateLimitNotice(info, t), null);
	rateLimitNotice({ status: "allowed" }, t);
	assert.ok(rateLimitNotice(info, t));
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
