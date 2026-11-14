import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildUsageReport, emptyUsageState, loadUsageState, recordAccount, recordRateLimit, saveUsageState,
} from "../src/usage-report.ts";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const inHours = (h) => Math.floor((NOW + h * 3_600_000) / 1000);

test("nothing reported yet means no panel row rather than a made-up 0%", () => {
	assert.equal(buildUsageReport("claude-bridge", emptyUsageState(), NOW), null);
});

test("a rate-limit event becomes a percent row with OMP's units (ms reset, 0..1 fractions)", () => {
	const state = emptyUsageState();
	assert.ok(recordRateLimit(state, { rateLimitType: "seven_day", utilization: 0.86, resetsAt: inHours(30), status: "allowed_warning" }, NOW));
	const report = buildUsageReport("claude-bridge", state, NOW);
	const [limit] = report.limits;
	assert.equal(limit.label, "7 days");
	assert.equal(limit.amount.unit, "percent");
	assert.ok(Math.abs(limit.amount.usedFraction - 0.86) < 1e-9);
	assert.ok(Math.abs(limit.amount.remaining - 14) < 1e-9);
	assert.equal(limit.window.resetsAt, inHours(30) * 1000);
	assert.equal(limit.status, "ok");
	assert.equal(limit.scope.shared, true);
	assert.equal(report.fetchedAt, NOW);
});

test("windows are listed 5-hour first, and each type keeps its latest report", () => {
	const state = emptyUsageState();
	recordRateLimit(state, { rateLimitType: "seven_day", utilization: 0.5, resetsAt: inHours(30) }, NOW);
	recordRateLimit(state, { rateLimitType: "five_hour", utilization: 0.2, resetsAt: inHours(2) }, NOW);
	recordRateLimit(state, { rateLimitType: "five_hour", utilization: 0.95, resetsAt: inHours(2) }, NOW);
	const report = buildUsageReport("claude-bridge", state, NOW);
	assert.deepEqual(report.limits.map((l) => l.label), ["5 hours", "7 days"]);
	assert.equal(report.limits[0].status, "warning");
});

test("a window whose reset time has passed shows as fresh, without a stale reset time", () => {
	const state = emptyUsageState();
	recordRateLimit(state, { rateLimitType: "five_hour", utilization: 0.9, resetsAt: inHours(-1) }, NOW - 3 * 3_600_000);
	const [limit] = buildUsageReport("claude-bridge", state, NOW).limits;
	assert.equal(limit.amount.usedFraction, 0);
	assert.equal(limit.window.resetsAt, undefined);
});

test("the per-window breakdown fills windows when the documented fields carry no percentage", () => {
	// Shape of a real low-usage event: status "allowed", no top-level utilization.
	const state = emptyUsageState();
	assert.ok(recordRateLimit(state, {
		status: "allowed", resetsAt: inHours(3), rateLimitType: "five_hour",
		unifiedWindows: { five_hour: { utilization: 0.17, resetsAt: inHours(3) }, seven_day: { utilization: 0.18, resetsAt: inHours(100) } },
	}, NOW));
	const report = buildUsageReport("claude-bridge", state, NOW);
	assert.deepEqual(report.limits.map((l) => [l.label, Math.round(l.amount.remaining)]), [["5 hours", 83], ["7 days", 82]]);
});

test("the documented fields win over the breakdown for the window they name", () => {
	const state = emptyUsageState();
	recordRateLimit(state, {
		rateLimitType: "seven_day", utilization: 0.86, resetsAt: inHours(30),
		unifiedWindows: { seven_day: { utilization: 0.5 }, five_hour: { utilization: "bad" } },
	}, NOW);
	assert.ok(Math.abs(state.windows.seven_day.utilization - 0.86) < 1e-9);
	assert.equal(state.windows.five_hour, undefined, "a malformed breakdown entry is skipped");
});

test("events without a window type or utilization are ignored", () => {
	const state = emptyUsageState();
	assert.equal(recordRateLimit(state, { status: "allowed" }, NOW), false);
	assert.equal(recordRateLimit(state, { rateLimitType: "five_hour" }, NOW), false);
	assert.equal(recordRateLimit(state, undefined, NOW), false);
});

test("the account label comes from accountInfo, and only for a claude.ai login", () => {
	const state = emptyUsageState();
	recordRateLimit(state, { rateLimitType: "five_hour", utilization: 0.1 }, NOW);
	assert.equal(recordAccount(state, { email: "me@example.com", subscriptionType: "max", apiProvider: "bedrock" }), false);
	assert.ok(recordAccount(state, { email: "me@example.com", subscriptionType: "max", apiProvider: "firstParty" }));
	assert.equal(recordAccount(state, { email: "me@example.com", subscriptionType: "max", apiProvider: "firstParty" }), false);
	assert.equal(buildUsageReport("claude-bridge", state, NOW).metadata.email, "me@example.com (max)");
});

test("state round-trips through its file, and a missing or broken file reads as empty", () => {
	const dir = mkdtempSync(join(tmpdir(), "ocb-usage-"));
	try {
		const path = join(dir, "nested", "usage.json");
		assert.deepEqual(loadUsageState(path), emptyUsageState());
		const state = emptyUsageState();
		recordRateLimit(state, { rateLimitType: "seven_day", utilization: 0.3, resetsAt: inHours(10) }, NOW);
		recordAccount(state, { email: "me@example.com", subscriptionType: "pro" });
		saveUsageState(path, state);
		assert.deepEqual(loadUsageState(path), state);
		const raw = readFileSync(path, "utf8");
		assert.ok(!/token|key|secret/i.test(raw), "nothing credential-like is stored");
		saveUsageState(path, /** @type {any} */ ({ windows: "nope" }));
		assert.deepEqual(loadUsageState(path), emptyUsageState());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a true account change discards the previous account's windows", () => {
	const state = emptyUsageState();
	recordAccount(state, { email: "old@example.com", subscriptionType: "pro" });
	recordRateLimit(state, { rateLimitType: "seven_day", utilization: 0.9 }, NOW);
	assert.ok(recordAccount(state, { email: "new@example.com", subscriptionType: "max" }));
	assert.deepEqual(state.windows, {});
	assert.equal(buildUsageReport("claude-bridge", state, NOW), null);
});

test("delayed accountInfo keeps new query observations but drops the old account's other windows", () => {
	const state = emptyUsageState();
	recordAccount(state, { email: "old@example.com", subscriptionType: "pro" });
	recordRateLimit(state, {
		unifiedWindows: { five_hour: { utilization: 0.9 }, seven_day: { utilization: 0.8 } },
	}, NOW - 1000);
	const queryStartedAt = NOW;
	recordRateLimit(state, { rateLimitType: "five_hour", utilization: 0.1 }, NOW + 1);
	assert.ok(recordAccount(state, { email: "new@example.com", subscriptionType: "max" }, queryStartedAt));
	const report = buildUsageReport("claude-bridge", state, NOW + 2);
	assert.equal(report.metadata.email, "new@example.com (max)");
	assert.deepEqual(report.limits.map((limit) => limit.label), ["5 hours"]);
	assert.equal(report.limits[0].amount.usedFraction, 0.1);
});

test("initial labels, plan updates, email casing and partial accountInfo do not invalidate observations", () => {
	const state = emptyUsageState();
	recordRateLimit(state, { rateLimitType: "five_hour", utilization: 0.3 }, NOW);
	recordAccount(state, { email: "me@example.com", subscriptionType: "pro" });
	recordAccount(state, { email: "ME@example.com", subscriptionType: "max" });
	recordAccount(state, { subscriptionType: "pro" });
	assert.equal(state.account.email, "ME@example.com");
	assert.equal(buildUsageReport("claude-bridge", state, NOW).limits[0].amount.usedFraction, 0.3);
});
