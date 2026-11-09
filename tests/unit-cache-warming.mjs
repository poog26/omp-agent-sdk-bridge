import test from "node:test";
import assert from "node:assert/strict";

import { subscriptionWarmingAction } from "../src/cache-warming.ts";

// The decision OMP made for a real 89K-token Opus 5.5 conversation that then lost its
// cache over an idle gap: just under OMP's $0.05 floor, though a miss costs ~24x a refresh.
const opusIdle = { warmCost: 0.0178, missCost: 0.4267, continuationProbability: 0.15, action: "stop" };

test("on a Claude plan, a refresh worth more than it costs is sent despite OMP's dollar floor", () => {
	assert.equal(subscriptionWarmingAction(opusIdle, true), "warm");
});

test("on an API key, OMP's own decision stands", () => {
	assert.equal(subscriptionWarmingAction(opusIdle, false), undefined);
});

test("a refresh that costs more than it is expected to save stays stopped", () => {
	assert.equal(subscriptionWarmingAction({ ...opusIdle, warmCost: 0.07 }, true), undefined);
	assert.equal(subscriptionWarmingAction({ ...opusIdle, continuationProbability: 0.01 }, true), undefined);
});

test("OMP's own 'warm' is never overridden, and missing economics are left alone", () => {
	assert.equal(subscriptionWarmingAction({ ...opusIdle, action: "warm" }, true), undefined);
	assert.equal(subscriptionWarmingAction({ ...opusIdle, missCost: 0, warmCost: 0 }, true), undefined);
	assert.equal(subscriptionWarmingAction({ ...opusIdle, missCost: Number.NaN }, true), undefined);
});
