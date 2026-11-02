import test from "node:test";
import assert from "node:assert/strict";

import {
	buildModels, buildVariantModels, claudeCodeModelId, effectiveWindow, parseVariantId, resolveModel,
} from "../src/models.ts";

// Shaped like OMP 18's Anthropic catalog entries (see getModels("anthropic")).
const CATALOG = [
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 64_000, thinking: { mode: "budget" } },
	{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-fable-5-1", name: "Claude Fable 5.1", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-mythos-5", name: "Claude Mythos 5", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-future-9", name: "Claude Future 9", contextWindow: 1_000_000, maxTokens: 128_000 },
];

const ONE_M = 1_000_000 - 23_000;
const TWO_K = 200_000 - 23_000;
const settings = (contextWindow = "auto", extra = {}) => ({ plan: "pro", longContextExtraUsage: false, contextWindow, ...extra });
const MODELS = buildModels(CATALOG);
const byId = (s) => Object.fromEntries(buildVariantModels(MODELS, s).map((m) => [m.id, m]));

test("catalog projection: newest first, flagship families first, no dated aliases, mythos hidden by default", () => {
	assert.deepEqual(MODELS.map((m) => m.id), [
		"claude-fable-5-1",
		"claude-opus-5-5", "claude-opus-4-7", "claude-opus-4-6",
		"claude-sonnet-5-5", "claude-sonnet-4-6",
		"claude-haiku-4-5",
		"claude-future-9",
	]);
	assert.ok(buildModels(CATALOG, []).some((m) => m.id === "claude-mythos-5"), "empty exclude list shows mythos");
	assert.ok(MODELS.every((m) => m.cost.input === 0), "subscription models carry no per-token price");
});

test("effective window leaves Claude Code's blocking margin (977K on 1M, 177K on 200K)", () => {
	assert.equal(effectiveWindow(1_000_000, 128_000), 977_000);
	assert.equal(effectiveWindow(200_000, 64_000), 177_000);
	assert.equal(effectiveWindow(200_000, 8_000), 189_000);
});

test("auto: measured models default to 1M, with a 200K alternate", () => {
	const m = byId(settings());
	assert.equal(m["claude-opus-5-5"].contextWindow, ONE_M);
	assert.equal(m["claude-opus-5-5"].name, "Claude Opus 5.5 (1M)");
	assert.equal(m["claude-opus-5-5-200k"].contextWindow, TWO_K);
	assert.equal(m["claude-opus-5-5-200k"].name, "Claude Opus 5.5 (200K)");
	assert.equal(m["claude-fable-5-1"].contextWindow, ONE_M);
	assert.equal(m["claude-sonnet-5-5"].contextWindow, ONE_M);
});

test("auto: opus-4-7's bare id is 1M and it has no 200K runtime", () => {
	const m = byId(settings());
	assert.equal(m["claude-opus-4-7"].contextWindow, ONE_M);
	assert.ok(!m["claude-opus-4-7-200k"]);
	assert.equal(claudeCodeModelId({ id: "claude-opus-4-7" }, settings()), "claude-opus-4-7");
});

test("auto: plan-gated models follow plan / extra usage", () => {
	assert.equal(byId(settings())["claude-opus-4-6"].contextWindow, TWO_K);
	assert.equal(byId(settings("auto", { plan: "max" }))["claude-opus-4-6"].contextWindow, ONE_M);
	assert.equal(byId(settings())["claude-sonnet-4-6"].contextWindow, TWO_K);
	assert.equal(byId(settings("auto", { longContextExtraUsage: true }))["claude-sonnet-4-6"].contextWindow, ONE_M);
	// The other window is always pickable.
	assert.equal(byId(settings())["claude-opus-4-6-1m"].contextWindow, ONE_M);
});

test("auto: an unmeasured model defaults to the safe 200K bare id, 1M offered as an opt-in variant", () => {
	const m = byId(settings());
	assert.equal(m["claude-future-9"].contextWindow, TWO_K);
	assert.equal(m["claude-future-9-1m"].contextWindow, ONE_M);
	assert.equal(claudeCodeModelId({ id: "claude-future-9" }, settings(), 1_000_000), "claude-future-9");
	assert.equal(claudeCodeModelId({ id: "claude-future-9-1m" }, settings(), 1_000_000), "claude-future-9[1m]");
});

test("a 200K-only model has no 1M variant", () => {
	const m = byId(settings());
	assert.equal(m["claude-haiku-4-5"].contextWindow, TWO_K);
	assert.ok(!m["claude-haiku-4-5-1m"]);
});

test("contextWindow 200k flips which window is unsuffixed; ids follow", () => {
	const m = byId(settings("200k"));
	assert.equal(m["claude-opus-5-5"].contextWindow, TWO_K);
	assert.equal(m["claude-opus-5-5-1m"].contextWindow, ONE_M);
	assert.equal(claudeCodeModelId({ id: "claude-opus-5-5" }, settings("200k")), "claude-opus-5-5");
	assert.equal(claudeCodeModelId({ id: "claude-opus-5-5-1m" }, settings("200k")), "claude-opus-5-5[1m]");
	// opus-4-7 has no 200K runtime: its only window stays unsuffixed.
	assert.equal(m["claude-opus-4-7"].contextWindow, ONE_M);
});

test("forceTwoHundredK pins one model's default without touching others", () => {
	const s = settings("auto", { forceTwoHundredK: ["claude-sonnet-5-5"] });
	const m = byId(s);
	assert.equal(m["claude-sonnet-5-5"].contextWindow, TWO_K);
	assert.equal(m["claude-sonnet-5-5-1m"].contextWindow, ONE_M);
	assert.equal(m["claude-opus-5-5"].contextWindow, ONE_M);
});

test("suffixed variant ids map to the matching runtime", () => {
	assert.equal(claudeCodeModelId({ id: "claude-opus-5-5" }, settings()), "claude-opus-5-5[1m]");
	assert.equal(claudeCodeModelId({ id: "claude-opus-5-5-200k" }, settings()), "claude-opus-5-5");
	assert.throws(() => claudeCodeModelId({ id: "claude-opus-4-7-200k" }, settings()), /no Claude Code runtime/);
});

test("parseVariantId splits suffixes; base ids pass through", () => {
	assert.deepEqual(parseVariantId("claude-opus-5-5-200k"), { baseId: "claude-opus-5-5", forced: "200k" });
	assert.deepEqual(parseVariantId("claude-fable-5-1-1m"), { baseId: "claude-fable-5-1", forced: "1m" });
	assert.deepEqual(parseVariantId("claude-fable-5-1"), { baseId: "claude-fable-5-1" });
});

test("resolveModel: family shortcut picks the newest; exact id wins", () => {
	assert.equal(resolveModel(MODELS, "opus").id, "claude-opus-5-5");
	assert.equal(resolveModel(MODELS, "sonnet").id, "claude-sonnet-5-5");
	assert.equal(resolveModel(MODELS, "claude-opus-4-6").id, "claude-opus-4-6");
	assert.equal(resolveModel(MODELS, "nope"), undefined);
});
