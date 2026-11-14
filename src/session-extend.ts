// Brings Claude Code's session file up to OMP's history without regenerating what
// Claude Code already wrote. Rebuilding from OMP's messages alone can't reproduce
// the records CC adds on its own (resume placeholders, environment/date/output-style
// attachments), so a rebuilt request diverged right after the system prompt and the
// whole conversation had to be written to the prompt cache again.

import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getSessionPath, normalizeProjectPath, openSession, type Session } from "cc-session-io";

export function sessionPath(sessionId: string, cwd: string): string {
	return getSessionPath(sessionId, normalizeProjectPath(cwd), process.env.CLAUDE_CONFIG_DIR);
}

export function sessionFileBytes(sessionId: string, cwd: string): number | undefined {
	try { return statSync(sessionPath(sessionId, cwd)).size; } catch { return undefined; }
}

export interface CleanState {
	sessionId: string;
	/** OMP messages the file mirrors. */
	cursor: number;
	/** OMP messages represented by cleanBytes; unlike cursor, this does not advance during a query. */
	cleanCursor?: number;
	/** Bytes of the file that mirror priors[0..cleanCursor) as CC wrote them. */
	cleanBytes?: number;
	/** A query completed: the whole file is clean, through the final assistant message after `cursor`. */
	completed?: boolean;
	needsRebuild?: boolean;
	/** An aborted CC process may still be writing to the old file. */
	forceRotate?: boolean;
}

export interface Extended {
	sessionId: string;
	cleanBytes: number | undefined;
	keptRecords: number;
	totalRecords: number;
	convertedMessages: number;
}

/**
 * After a completed query the file is extended in place. After an aborted or
 * failed one, the bytes measured when it started are copied verbatim (into a
 * fresh id when an orphan writer may still be flushing) and OMP's later messages
 * are converted after them. Undefined when there is no clean prefix to keep;
 * the caller then rebuilds from OMP's history.
 */
export function extendCleanSession<M extends { role?: string }>(
	state: CleanState,
	priorMessages: readonly M[],
	cwd: string,
	importTail: (session: Session, messages: M[]) => void,
): Extended | undefined {
	let tail = priorMessages.slice(state.cursor);
	let targetId = state.sessionId;
	if (state.completed && !state.needsRebuild) {
		// CC already wrote the final assistant message that follows `cursor`.
		if (tail[0]?.role === "assistant") tail = tail.slice(1);
	} else if (state.cleanBytes !== undefined && state.cleanBytes > 0) {
		if (state.cleanCursor === undefined || !Number.isSafeInteger(state.cleanCursor) || state.cleanCursor < 0 || state.cleanCursor > priorMessages.length) return undefined;
		tail = priorMessages.slice(state.cleanCursor);
		const bytes = readFileSync(sessionPath(state.sessionId, cwd)).subarray(0, state.cleanBytes);
		const end = bytes.lastIndexOf(0x0a);
		if (end < 0) return undefined;
		targetId = state.forceRotate ? randomUUID() : state.sessionId;
		const lines = bytes.subarray(0, end).toString("utf-8").split("\n").filter(Boolean).map((line) => {
			const record = JSON.parse(line) as Record<string, unknown>;
			if ("sessionId" in record) record.sessionId = targetId;
			return JSON.stringify(record);
		});
		const targetPath = sessionPath(targetId, cwd);
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, lines.join("\n") + "\n", "utf-8");
	} else {
		return undefined;
	}
	const session = openSession({ sessionId: targetId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
	const keptRecords = session.records.length;
	importTail(session, tail);
	session.save();
	return { sessionId: targetId, cleanBytes: sessionFileBytes(targetId, cwd), keptRecords, totalRecords: session.records.length, convertedMessages: tail.length };
}
