// Idle cache-warming decisions for Claude turns on a Claude plan.
//
// OMP's cache warmer refreshes a prompt-cache entry shortly before it expires, but only
// when `continuationProbability * missCost - warmCost` clears a fixed $0.05. That floor
// is about money. On a Claude plan nothing is billed per request; both a refresh (a cache
// read) and a miss (a full cache write) draw on plan usage in proportion to their token
// prices. So the bridge keeps OMP's estimate and drops only the dollar floor: refresh
// whenever the expected saving is larger than the refresh itself. A 90K Opus prefix
// sits just under the floor (about $0.046 expected saving) yet a miss costs ~25x a
// refresh, which is why idle gaps were losing the cache.
//
// OMP's own limits still apply: warming stops after 30 idle minutes, when the
// conversation changes, or when a refresh misses.

export interface WarmingDecision {
	warmCost: number;
	missCost: number;
	continuationProbability: number;
	action: "warm" | "stop";
}

/** The bridge's override for one decision, or undefined to leave OMP's decision as it is. */
export function subscriptionWarmingAction(event: WarmingDecision, onSubscription: boolean): "warm" | undefined {
	if (!onSubscription || event.action === "warm") return undefined;
	const { warmCost, missCost, continuationProbability } = event;
	if (![warmCost, missCost, continuationProbability].every(Number.isFinite)) return undefined;
	if (missCost <= 0 || warmCost <= 0) return undefined;
	return continuationProbability * missCost > warmCost ? "warm" : undefined;
}
