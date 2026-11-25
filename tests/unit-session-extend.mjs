import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { extendCleanSession, latestRoundOnDisk, sessionFileBytes, sessionPath } from "../src/session-extend.ts";
import { convertPiMessages } from "../src/convert.ts";

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
	const state = { sessionId: sid, cursor: 2, cleanCursor: 2, cleanBytes: Buffer.byteLength(ccText), needsRebuild: true, forceRotate: true };
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
	const result = extendCleanSession({ sessionId: sid, cursor: 2, cleanCursor: 2, cleanBytes: Buffer.byteLength(ccText), needsRebuild: true }, history, cwd, importTail);
	assert.equal(result.sessionId, sid);
	assert.ok(!readFileSync(sessionPath(sid, cwd), "utf-8").includes("garbage"));
});

test("without a clean prefix (history rewritten) the caller rebuilds from OMP", () => {
	writeCc();
	assert.equal(extendCleanSession({ sessionId: sid, cursor: 2, needsRebuild: true }, history, cwd, importTail), undefined);
	assert.equal(extendCleanSession({ sessionId: sid, cursor: 2, cleanBytes: 0, needsRebuild: true }, history, cwd, importTail), undefined);
});

for (const forceRotate of [false, true]) {
	test(`recovery after ${forceRotate ? "abort" : "error"} replays from the snapshot cursor after tool results advance the live cursor`, () => {
		writeCc("incomplete record after the snapshot");
		const messages = [
			{ role: "user", content: "first question" },
			{ role: "assistant", content: [{ type: "text", text: "first answer" }] },
			{ role: "user", content: "current question" },
			{ role: "assistant", content: [{ type: "toolCall", id: "call:current", name: "read", arguments: { path: "current.txt" } }] },
			{ role: "toolResult", toolCallId: "call:current", content: [{ type: "text", text: "current tool result" }], isError: false },
			{ role: "assistant", content: [{ type: "text", text: "partial current answer" }] },
		];
		const result = extendCleanSession({
			sessionId: sid, cursor: 5, cleanCursor: 2, cleanBytes: Buffer.byteLength(ccText), needsRebuild: true, forceRotate,
		}, messages, cwd, (session, tail) => session.importMessages(convertPiMessages(tail).anthropicMessages));
		assert.equal(result.convertedMessages, 4);
		assert.equal(result.keptRecords, ccRecords.length);
		const records = readFileSync(sessionPath(result.sessionId, cwd), "utf-8").trim().split("\n").map(JSON.parse);
		assert.deepEqual(records.slice(ccRecords.length).map(({ message: { role, content } }) => ({ role, content })), [
			{ role: "user", content: "current question" },
			{ role: "assistant", content: [{ type: "tool_use", id: "call_current", name: "Read", input: { path: "current.txt" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_current", content: "current tool result" }] },
			{ role: "assistant", content: [{ type: "text", text: "partial current answer" }] },
		]);
	});
}

test("snapshot bytes without a valid associated cursor require a full rebuild", () => {
	const path = writeCc();
	for (const cleanCursor of [undefined, -1, 1.5, history.length + 1, NaN]) {
		assert.equal(extendCleanSession({
			sessionId: sid, cursor: 2, cleanCursor, cleanBytes: Buffer.byteLength(ccText), needsRebuild: true,
		}, history, cwd, importTail), undefined);
		assert.equal(readFileSync(path, "utf-8"), ccText);
	}
});

// One tool round of a running query as CC writes it: a record per content block,
// parallel tool calls in separate records, then records of its own.
const roundRecords = [
	{ ...base, type: "user", uuid: "u2", parentUuid: "r1", message: { role: "user", content: "current question" } },
	{ ...base, type: "assistant", uuid: "t1", parentUuid: "u2", message: { role: "assistant", id: "msg_2", content: [{ type: "text", text: "reading both" }] } },
	{ ...base, type: "assistant", uuid: "t2", parentUuid: "t1", message: { role: "assistant", id: "msg_2", content: [{ type: "tool_use", id: "toolu_a", name: "Read", input: {} }] } },
	{ ...base, type: "assistant", uuid: "t3", parentUuid: "t2", message: { role: "assistant", id: "msg_2", content: [{ type: "tool_use", id: "toolu_b", name: "Read", input: {} }] } },
	{ ...base, type: "attachment", uuid: "a2", parentUuid: "t3", attachment: { type: "date", content: "AFTER THE TOOL CALLS" } },
];
const roundText = roundRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";
const throughToolUses = Buffer.byteLength(ccText + roundRecords.slice(0, 4).map((r) => JSON.stringify(r)).join("\n") + "\n");

test("a rollback keeps CC's records through the newest tool round it has written, ignoring half-written lines", () => {
	const data = Buffer.from(ccText + roundText + '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_c"');
	const from = Buffer.byteLength(ccText);
	const round = { cursor: 4, toolUseIds: ["toolu_a", "toolu_b"] };
	const unwritten = { cursor: 6, toolUseIds: ["toolu_c"] };
	assert.deepEqual(latestRoundOnDisk(data, from, [round, unwritten]), { round, bytes: throughToolUses }, "toolu_c is only in a half-written line");
	assert.equal(latestRoundOnDisk(data, throughToolUses, [round]), undefined, "records before `from` are not searched");
	assert.equal(latestRoundOnDisk(data, data.length + 1000, [round]), undefined);
});

test("after an abort at a tool round, CC's records for the round are kept and OMP's results answer them", () => {
	writeCc(roundText + JSON.stringify({ type: "user", sessionId: sid, uuid: "late", message: { role: "user", content: "[Request interrupted by user]" } }) + "\n");
	const messages = [
		{ role: "user", content: "first question" },
		{ role: "assistant", content: [{ type: "text", text: "first answer" }] },
		{ role: "user", content: "current question" },
		{ role: "assistant", content: [{ type: "text", text: "reading both" }, { type: "toolCall", id: "toolu_a", name: "read", arguments: {} }, { type: "toolCall", id: "toolu_b", name: "read", arguments: {} }] },
		{ role: "toolResult", toolCallId: "toolu_a", content: [{ type: "text", text: "result a" }], isError: false },
		{ role: "toolResult", toolCallId: "toolu_b", content: [{ type: "text", text: "aborted" }], isError: true },
		{ role: "assistant", content: [] },
	];
	const result = extendCleanSession({
		sessionId: sid, cursor: 6, cleanCursor: 2, cleanBytes: Buffer.byteLength(ccText), needsRebuild: true, forceRotate: true,
		toolRounds: [{ cursor: 4, toolUseIds: ["toolu_a", "toolu_b"] }, { cursor: 7, toolUseIds: ["toolu_unwritten"] }],
	}, messages, cwd, (session, tail) => session.importMessages(convertPiMessages(tail).anthropicMessages));
	assert.equal(result.keptRecords, ccRecords.length + 4);
	const records = readFileSync(sessionPath(result.sessionId, cwd), "utf-8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(records.slice(0, result.keptRecords).map((r) => r.uuid), [...ccRecords, ...roundRecords.slice(0, 4)].map((r) => r.uuid));
	const [answer, ...rest] = records.slice(result.keptRecords);
	assert.equal(answer.parentUuid, "t3");
	assert.deepEqual(answer.message.content.map((b) => [b.tool_use_id, b.content, Boolean(b.is_error)]), [["toolu_a", "result a", false], ["toolu_b", "aborted", true]]);
	assert.deepEqual(rest.map((r) => r.message.role), ["assistant"]);
	assert.ok(!records.some((r) => r.uuid === "a2" || r.uuid === "late"), "records after the clean point are dropped");
});
