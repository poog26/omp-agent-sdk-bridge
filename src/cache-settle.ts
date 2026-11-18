// Holding a fast follow-up request until a large prompt-cache write is readable.
//
// Anthropic documents a cache entry as readable once the response that writes it starts.
// Large writes take longer in practice. In the usage ledger, every request sent within
// ~4s of the response start of a 111K-174K token write re-wrote it in full, while every
// request sent 5s or more after a 137K-191K write read it; writes under ~50K were
// readable after 2s. A rebuilt or freshly started session has exactly that shape: one
// large write, then a quick tool call that OMP answers in milliseconds, and Claude Code
// sends the next request at once. Each such miss writes the whole history again.
//
// Claude Code sends that next request only when the bridge hands it the tool results,
// so after a large write the bridge holds them until the write has had time to become
// readable. A tool that runs longer than the settle time is never held.

/** Cache writes at least this large are held for; smaller ones are readable in time. */
export const LARGE_CACHE_WRITE_TOKENS = 64_000;
/** How long after the writing response starts a large write is taken to be readable. */
export const CACHE_SETTLE_MS = 5_000;

/** When a request's cache write is readable, from its response start; 0 when it needs no wait. */
export function cacheReadableAt(startedAt: number, cacheWrite: number): number {
	return cacheWrite >= LARGE_CACHE_WRITE_TOKENS ? startedAt + CACHE_SETTLE_MS : 0;
}
