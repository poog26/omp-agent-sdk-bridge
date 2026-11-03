import test from "node:test";
import assert from "node:assert/strict";

import { applyClaudeUsage } from "../src/usage.ts";
import { buildModels } from "../src/models.ts";

// A stand-in for OMP's calculateCost: per-million rates applied to each bucket, with the
// same field names OMP uses, so the wiring (not the arithmetic) is what's under test.
function price(model, usage) {
	const c = model.cost;
	usage.cost.input = (c.input / 1e6) * usage.input;
	usage.cost.output = (c.output / 1e6) * usage.output;
	usage.cost.cacheRead = (c.cacheRead / 1e6) * usage.cacheRead;
	usage.cost.cacheWrite = (c.cacheWrite / 1e6) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const opus = { cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } };

test("token counts map across and the cost is priced with the model's list prices", () => {
	const target = blank();
	applyClaudeUsage(target, { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, opus, price);
	assert.equal(target.input, 1_000_000);
	assert.equal(target.output, 500_000);
	assert.equal(target.totalTokens, 1_500_000);
	assert.equal(target.cost.input, 4);
	assert.equal(target.cost.output, 10);
	assert.equal(target.cost.total, 14);
});

test("a cumulative snapshot replaces the previous one instead of adding to it", () => {
	const target = blank();
	applyClaudeUsage(target, { input_tokens: 100, output_tokens: 5 }, opus, price);
	applyClaudeUsage(target, { input_tokens: 100, output_tokens: 50 }, opus, price);
	assert.equal(target.output, 50);
	assert.equal(target.totalTokens, 150);
});

test("a missing field keeps the value it had, and nothing is reported as NaN", () => {
	const target = blank();
	applyClaudeUsage(target, { input_tokens: 7, output_tokens: null, cache_read_input_tokens: "x" }, opus, price);
	assert.equal(target.input, 7);
	assert.equal(target.output, 0);
	assert.equal(target.cacheRead, 0);
	assert.ok(Number.isFinite(target.cost.total));
});

test("the 5-minute and 1-hour cache-write split is passed on for OMP to price", () => {
	const target = blank();
	applyClaudeUsage(target, {
		cache_creation_input_tokens: 1000,
		cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 800 },
	}, opus, price);
	assert.deepEqual(target.cttl, { ephemeral5m: 200, ephemeral1h: 800 });
	applyClaudeUsage(target, { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }, opus, price);
	assert.equal(target.cttl, undefined, "an explicit zero split clears the earlier one");
});

test("reasoning tokens are reported when Claude Code gives them", () => {
	const target = blank();
	assert.equal(applyClaudeUsage(target, { thinking_tokens: 42 }, opus, price), 42);
	assert.equal(target.reasoning, 42);
	assert.equal(applyClaudeUsage(blank(), {}, opus, price), undefined);
});

test("registered Claude models keep OMP's list prices instead of being zeroed", () => {
	const catalog = [{
		id: "claude-opus-5-5", name: "Opus 5.5", reasoning: true, input: ["text", "image"],
		contextWindow: 1_000_000, maxTokens: 64_000, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	}];
	const [model] = buildModels(catalog);
	assert.deepEqual(model.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
});

test("a model with no catalog price still gets a complete, zeroed cost so OMP can price it", () => {
	const [model] = buildModels([{ id: "claude-x-1", name: "X", reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1 }]);
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
