import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { extendCleanSession, sessionFileBytes, sessionPath } from "../src/session-extend.ts";

// A throwaway Claude config dir; sessionPath reads CLAUDE_CONFIG_DIR at call time.
const ccDir = mkdtempSync(join(tmpdir(), "ocb-cc-"));
process.env.CLAUDE_CONFIG_DIR = ccDir;
test.after(() => rmSync(ccDir, { recursive: true, force: true }));

const cwd = ccDir;
const sid = "11111111-2222-4333-8444-555555555555";
const base = { sessionId: sid, cwd, isSidechain: false, userType: "external", version: "2.1.308" };
// What CC writes for one exchange, including an attachment OMP's history doesn't have.
const ccRecords = [
	{ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-11-06T10:00:00.000Z", message: { role: "user", content: "first question" } },
	{ ...base, type: "attachment", uuid: "a1", parentUuid: "u1", timestamp: "2026-11-06T10:00:00.001Z", attachment: { type: "date", content: "CC-ONLY ATTACHMENT" } },
	{ ...base, type: "assistant", uuid: "r1", parentUuid: "a1", timestamp: "2026-11-06T10:00:01.000Z", message: { role: "assistant", id: "msg_1", type: "message", model: "claude-haiku-5-5", content: [{ type: "text", text: "first answer" }], stop_reason: "end_turn" } },
];
const ccText = ccRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";
const omp = (role, text) => ({ role, text });
const history = [omp("user", "first question"), omp("assistant", "first answer"), omp("user", "second question")];
// Stand-in for the bridge's converter: one user record per OMP message.
const importTail = (session, msgs) => { for (const m of msgs) if (m.role === "user") session.addUserMessage(m.text); else session.addAssistantMessage([{ type: "text", text: m.text || "(empty)" }]); };

function writeCc(extra = "") {
	const path = sessionPath(sid, cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, ccText + extra);
	return path;
}

test("after a completed query, CC's own records stay byte-for-byte and OMP's new messages follow", () => {
	const path = writeCc();
	const result = extendCleanSession({ sessionId: sid, cursor: 1, completed: true }, history, cwd, importTail);
	const text = readFileSync(path, "utf-8");
	assert.equal(result.sessionId, sid);
	assert.ok(text.startsWith(ccText), "CC's records are untouched");
	assert.ok(text.includes("second question"));
	assert.ok(!text.slice(ccText.length).includes("first answer"), "the final assistant CC already wrote is not added twice");
	const appended = JSON.parse(text.slice(ccText.length).split("\n")[0]);
	assert.equal(appended.parentUuid, "r1", "the new message chains from CC's last record");
	assert.equal(result.cleanBytes, sessionFileBytes(sid, cwd));
});

test("after an abort, the bytes measured at the turn's start are kept in a fresh session", () => {
	writeCc(JSON.stringify({ type: "user", sessionId: sid, uuid: "late", message: { role: "user", content: "[Request interrupted by user]" } }) + "\n");
	const state = { sessionId: sid, cursor: 2, cleanBytes: Buffer.byteLength(ccText), needsRebuild: true, forceRotate: true };
	const result = extendCleanSession(state, [...history, omp("assistant", "")], cwd, importTail);
	assert.notEqual(result.sessionId, sid, "an orphan writer may still flush to the old id");
	const text = readFileSync(sessionPath(result.sessionId, cwd), "utf-8");
	assert.ok(text.includes("CC-ONLY ATTACHMENT"));
	assert.ok(text.includes("second question"));
	assert.ok(!text.includes("[Request interrupted by user]"), "records after the turn start are dropped");
	assert.ok(!text.includes(`"sessionId":"${sid}"`), "copied records carry the new id");
	assert.equal(result.keptRecords, ccRecords.length);
});

test("a failed query without rotation keeps the prefix under the same id", () => {
	writeCc("garbage line from a half-written record");
	const result = extendCleanSession({ sessionId: sid, cursor: 2, cleanBytes: Buffer.byteLength(ccText), needsRebuild: true }, history, cwd, importTail);
	assert.equal(result.sessionId, sid);
	assert.ok(!readFileSync(sessionPath(sid, cwd), "utf-8").includes("garbage"));
});

test("without a clean prefix (history rewritten) the caller rebuilds from OMP", () => {
	writeCc();
	assert.equal(extendCleanSession({ sessionId: sid, cursor: 2, needsRebuild: true }, history, cwd, importTail), undefined);
	assert.equal(extendCleanSession({ sessionId: sid, cursor: 2, cleanBytes: 0, needsRebuild: true }, history, cwd, importTail), undefined);
});
