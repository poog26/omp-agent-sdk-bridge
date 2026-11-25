// Brings Claude Code's session file up to OMP's history without regenerating what
// Claude Code already wrote. Rebuilding from OMP's messages alone can't reproduce
// the records CC adds on its own (resume placeholders, environment/date/output-style
// attachments), so a rebuilt request diverged right after the system prompt and the
// whole conversation had to be written to the prompt cache again.

import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getSessionPath, normalizeProjectPath, openSession, type Session } from "cc-session-io";
import { convertPiMessages } from "./convert.js";

export function sessionPath(sessionId: string, cwd: string): string {
	return getSessionPath(sessionId, normalizeProjectPath(cwd), process.env.CLAUDE_CONFIG_DIR);
}

export function sessionFileBytes(sessionId: string, cwd: string): number | undefined {
	try { return statSync(sessionPath(sessionId, cwd)).size; } catch { return undefined; }
}

/** A tool round of a running query, in OMP's messages and in Claude Code's records. */
export interface ToolRound {
	/** OMP messages through the assistant message whose tool calls the round answered. */
	cursor: number;
	toolUseIds: readonly string[];
}

/**
 * The newest of `rounds` whose tool_use records Claude Code has written, with the
 * byte offset just past the last of them. Searches complete lines from `from` (a
 * line boundary). Claude Code can write a round's records after the round's results
 * already reached the bridge, so this is only answered when rolling back, not at
 * the round itself.
 */
export function latestRoundOnDisk(data: Buffer, from: number, rounds: readonly ToolRound[]): { round: ToolRound; bytes: number } | undefined {
	const lineEnds = new Map<string, number>();
	let start = from;
	let lineEnd = data.indexOf(0x0a, start);
	// Complete lines only: Claude Code may be mid-write.
	while (lineEnd >= 0) {
		const line = data.subarray(start, lineEnd);
		if (line.includes('"tool_use"')) {
			for (const id of toolUseIdsIn(line.toString("utf-8"))) lineEnds.set(id, lineEnd + 1);
		}
		start = lineEnd + 1;
		lineEnd = data.indexOf(0x0a, start);
	}
	for (let i = rounds.length - 1; i >= 0; i--) {
		const ends = rounds[i].toolUseIds.map((id) => lineEnds.get(id));
		if (ends.length > 0 && ends.every((end) => end !== undefined)) return { round: rounds[i], bytes: Math.max(...ends) };
	}
	return undefined;
}

function toolUseIdsIn(line: string): string[] {
	try {
		const record = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
		const content = record.type === "assistant" ? record.message?.content : undefined;
		if (!Array.isArray(content)) return [];
		return content.filter((b) => b?.type === "tool_use" && typeof b.id === "string").map((b) => b.id as string);
	} catch {
		return [];
	}
}

export interface CleanState {
	sessionId: string;
	/** OMP messages the file mirrors. */
	cursor: number;
	/** OMP messages represented by cleanBytes; unlike cursor, this does not advance during a query. */
	cleanCursor?: number;
	/** Bytes of the file that mirror priors[0..cleanCursor) as CC wrote them. */
	cleanBytes?: number;
	/** Tool rounds of the running query after cleanCursor, oldest first. */
	toolRounds?: readonly ToolRound[];
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
 * failed one, CC's records are kept verbatim through the newest tool round it has
 * written, or else through the bytes measured when the query started (into a fresh
 * id when an orphan writer may still be flushing), and OMP's later messages are
 * converted after them. Undefined when there is no clean prefix to keep; the
 * caller then rebuilds from OMP's history.
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
		const cleanCursor = state.cleanCursor;
		if (cleanCursor === undefined || !Number.isSafeInteger(cleanCursor) || cleanCursor < 0 || cleanCursor > priorMessages.length) return undefined;
		const file = readFileSync(sessionPath(state.sessionId, cwd));
		// Keeping CC's records for the query's tool rounds keeps the requests it sent
		// for them: converting those rounds from OMP's messages diverged from what was
		// sent, and past the API's 20-block cache lookback nothing after the system
		// prompt was read.
		const rounds = (state.toolRounds ?? []).filter((r) => r.cursor > cleanCursor && r.cursor <= priorMessages.length && priorMessages[r.cursor - 1]?.role === "assistant");
		const latest = latestRoundOnDisk(file, state.cleanBytes, rounds);
		tail = priorMessages.slice(latest?.round.cursor ?? cleanCursor);
		const bytes = file.subarray(0, latest?.bytes ?? state.cleanBytes);
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
	// A clean point taken at a tool round ends on Claude Code's tool_use records. Their
	// results answer those records directly; importMessages would drop them as orphans.
	const answered = tail.findIndex((m) => m.role !== "toolResult");
	const results = answered < 0 ? tail : tail.slice(0, answered);
	if (results.length > 0) {
		const [message] = convertPiMessages(results as never[]).anthropicMessages;
		const blocks = Array.isArray(message?.content) ? message.content : [];
		session.addToolResults(blocks.flatMap((b) => b.type === "tool_result" ? [{ toolUseId: b.tool_use_id, content: b.content, isError: b.is_error }] : []));
	}
	importTail(session, tail.slice(results.length));
	session.save();
	return { sessionId: targetId, cleanBytes: sessionFileBytes(targetId, cwd), keptRecords, totalRecords: session.records.length, convertedMessages: tail.length };
}
