import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { QueryMeter, appendLedger, detectMiss, readLedger, summarizeLedger } from "../src/usage-ledger.ts";

const FP = { system: "s1", tools: "t1", thinking: "k1" };
const prev = (over = {}) => ({ endedAt: 1_000_000, prompt: 100_000, model: "claude-opus-5-5", fingerprint: FP, ...over });
const call = (over = {}) => ({
	startedAt: 1_000_000 + 60_000,
	model: "claude-opus-5-5",
	tokens: { input: 2, cacheRead: 25_000, cacheWrite: 80_000, output: 300 },
	fingerprint: FP,
	sync: "reuse",
	...over,
});

test("a request inside the cache lifetime that re-writes the cached prefix is a miss", () => {
	const miss = detectMiss(prev(), call(), 300);
	assert.equal(miss.lost, 75_000);
	assert.equal(miss.expected, false);
	assert.match(miss.cause, /unexplained/);
});

test("a request that reads the previous prefix is not a miss", () => {
	assert.equal(detectMiss(prev(), call({ tokens: { input: 2, cacheRead: 100_000, cacheWrite: 3_000, output: 10 } }), 300), undefined);
});

test("after the cache lifetime has passed, a re-write is not counted as a miss", () => {
	assert.equal(detectMiss(prev(), call({ startedAt: 1_000_000 + 301_000 }), 300), undefined);
	assert.ok(detectMiss(prev(), call({ startedAt: 1_000_000 + 301_000 }), 3600), "a 1h lifetime still covers it");
});

test("a different model has its own cache, so its first request is not a miss", () => {
	assert.equal(detectMiss(prev({ model: "claude-haiku-5-5" }), call(), 300), undefined);
});

test("small shortfalls are noise, not misses", () => {
	assert.equal(detectMiss(prev({ prompt: 2_000 }), call({ tokens: { input: 2, cacheRead: 0, cacheWrite: 2_000, output: 1 } }), 300), undefined);
});

test("a shorter history only counts what both requests share", () => {
	// Compaction halved the prompt: what the new request could have read is its own size.
	const miss = detectMiss(prev(), call({ tokens: { input: 2, cacheRead: 25_000, cacheWrite: 25_000, output: 1 } }), 300);
	assert.equal(miss.lost, 25_002);
});

test("causes: a history rewrite is expected, and changed inputs are named before a rebuild", () => {
	assert.equal(detectMiss(prev(), call({ historyRewritten: true, sync: "rebuild" }), 300).expected, true);
	assert.match(detectMiss(prev(), call({ fingerprint: { ...FP, tools: "t2", system: "s2" } }), 300).cause, /tool list/);
	assert.match(detectMiss(prev(), call({ fingerprint: { ...FP, system: "s2" }, sync: "rebuild" }), 300).cause, /system prompt/);
	assert.match(detectMiss(prev(), call({ fingerprint: { ...FP, thinking: "k2" } }), 300).cause, /thinking/);
	assert.match(detectMiss(prev(), call({ sync: "rebuild" }), 300).cause, /rebuilt/);
});

const start = (usage) => ({ type: "message_start", message: { usage } });
const delta = (usage) => ({ type: "message_delta", usage });
const stop = { type: "message_stop" };

test("the meter reports each request with its final output count, in order", () => {
	const calls = [];
	const meter = new QueryMeter((index, _startedAt, tokens, aborted) => calls.push({ index, tokens, aborted }));
	meter.event(start({ input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 3000, output_tokens: 1 }));
	meter.event(delta({ output_tokens: 54 }));
	meter.event(stop);
	meter.event(start({ input_tokens: 2, cache_read_input_tokens: 3000, cache_creation_input_tokens: 85, output_tokens: 1 }));
	meter.event(delta({ output_tokens: 3 }));
	meter.event(stop);
	meter.close();
	assert.deepEqual(calls.map((c) => [c.index, c.tokens.cacheWrite, c.tokens.output, c.aborted]), [[0, 3000, 54, false], [1, 85, 3, false]]);
	assert.deepEqual(meter.observed, { input: 4, cacheRead: 3000, cacheWrite: 3085, output: 57 });
});

test("a request cut off before message_stop is still reported, as aborted", () => {
	const calls = [];
	const meter = new QueryMeter((_i, _s, tokens, aborted) => calls.push({ tokens, aborted }));
	meter.event(start({ input_tokens: 2, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, output_tokens: 1 }));
	meter.close();
	meter.close();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].aborted, true);
	assert.equal(calls[0].tokens.cacheRead, 50_000);
});

test("usage in Claude Code's query total that was never streamed is reported as unattributed", () => {
	const meter = new QueryMeter(() => {});
	meter.event(start({ input_tokens: 2, cache_read_input_tokens: 2987, cache_creation_input_tokens: 85, output_tokens: 1 }));
	meter.event(delta({ output_tokens: 3 }));
	meter.event(stop);
	const streamed = { input_tokens: 2, cache_read_input_tokens: 2987, cache_creation_input_tokens: 85, output_tokens: 3 };
	assert.equal(meter.unattributed(streamed), undefined);
	const extra = meter.unattributed({ ...streamed, input_tokens: 4002, output_tokens: 503 });
	assert.deepEqual(extra, { input: 4000, cacheRead: 0, cacheWrite: 0, output: 500 });
});

test("the summary counts only conversation requests in the hit rate and splits expected misses", () => {
	const s = summarizeLedger([
		{ ts: 1, kind: "turn", model: "m", input: 0, cacheRead: 90, cacheWrite: 10, output: 5 },
		{ ts: 2, kind: "warm", model: "m", input: 0, cacheRead: 1000, cacheWrite: 0, output: 1 },
		{ ts: 3, kind: "turn", model: "m", input: 0, cacheRead: 0, cacheWrite: 100, output: 5, miss: { lost: 90, cause: "x", expected: false } },
		{ ts: 4, kind: "turn", model: "m", input: 0, cacheRead: 0, cacheWrite: 100, output: 5, miss: { lost: 70, cause: "y", expected: true } },
	]);
	assert.equal(s.hitRate, 90 / 300);
	assert.equal(s.byKind.warm.requests, 1);
	assert.equal(s.misses.length, 1);
	assert.equal(s.expectedMisses.length, 1);
	assert.equal(s.lostTokens, 90);
});

test("the ledger reads back entries from a time on, skipping a torn line", () => {
	const dir = mkdtempSync(join(tmpdir(), "ledger-"));
	try {
		const path = join(dir, "usage-ledger.jsonl");
		appendLedger(path, { ts: 10, kind: "turn", model: "m", input: 1, cacheRead: 0, cacheWrite: 0, output: 0 });
		appendLedger(path, { ts: 20, kind: "one-shot", model: "m", input: 2, cacheRead: 0, cacheWrite: 0, output: 0 });
		appendFileSync(path, '{"ts": 30, "kind": "tu');
		assert.deepEqual(readLedger(path, 15).map((e) => e.kind), ["one-shot"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
