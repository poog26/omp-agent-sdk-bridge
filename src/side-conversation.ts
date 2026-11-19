// OMP side requests (/btw and the like) carry the whole main conversation followed by
// their own exchange. Most are one-shot, but a side request with a conversation key
// (/btw follow-ups) is continued: OMP sends the next question under the same session
// id and keeps provider state for it. Its mirror is kept between those turns so Claude
// Code resumes it and reads the cached conversation instead of writing it all again.
//
// A side conversation's history can change under its mirror without any OMP event: the
// main conversation it embeds keeps moving while the side conversation sits idle. Each
// message the mirror covers is fingerprinted, and a mirror whose messages changed is
// rebuilt rather than resumed.

import { createHash } from "node:crypto";

/** OMP's session id for a continued side conversation: `<session>:side:conversation:<key>`. */
export function isSideConversation(sessionKey: string): boolean {
	return sessionKey.includes(":side:conversation:");
}

/** One hash per message, over what the model sees (role and content, not timestamps). */
export function messageFingerprints(messages: readonly { role?: string; content?: unknown }[]): string[] {
	return messages.map((m) => createHash("sha256").update(JSON.stringify([m.role, m.content]) ?? "").digest("hex").slice(0, 16));
}

/**
 * Index of the first of the `upTo` leading messages that differs from what the mirror
 * was built from, or undefined when they all match. Messages the mirror never recorded
 * count as changed.
 */
export function firstChangedMessage(known: readonly string[], messages: readonly { role?: string; content?: unknown }[], upTo: number): number | undefined {
	const current = messageFingerprints(messages.slice(0, upTo));
	for (let i = 0; i < upTo; i++) {
		if (known[i] === undefined || known[i] !== current[i]) return i;
	}
	return undefined;
}
