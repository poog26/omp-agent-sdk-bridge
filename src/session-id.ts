// Stable Claude Code session ids for the bridge's session mirrors.
//
// Each OMP session gets one deterministic Claude Code session id, so restarting OMP
// rewrites that mirror in place instead of leaving another session file behind in
// ~/.claude/projects every time.

import { createHash } from "node:crypto";

/** UUID-shaped (version 4 layout) id derived from the OMP session key. */
export function mirrorIdFor(sessionKey: string): string {
	const hex = createHash("sha256").update(`omp-agent-sdk-bridge:${sessionKey}`).digest("hex").slice(0, 32).split("");
	hex[12] = "4";
	hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
	const h = hex.join("");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
