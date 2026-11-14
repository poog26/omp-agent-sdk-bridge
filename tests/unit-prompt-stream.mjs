// Ported from pi-claude-bridge (MIT, Eli Dickinson), tests/unit-prompt-stream.mjs.
/**
 * Unit tests for makePromptStream — the streaming-input prompt behind mid-turn
 * steering.
 *
 * The consumer here mirrors the SDK's real pump:
 *   for await (const m of stream) { await transport.write(m) }
 * The ack contract only holds against that shape, so the tests exercise it
 * rather than a bare `for await`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makePromptStream, userMessage } from "../src/prompt-stream.js";

const text = (msg) => msg.message.content[0].text;

/** Drives the stream like the SDK does. `write` may return a promise; the pump
 *  awaits it before pulling the next message. */
function pump(stream, write) {
	return (async () => {
		for await (const msg of stream) await write(msg);
	})();
}

describe("makePromptStream", () => {
	it("resolves the ack only after the write completes", async () => {
		const ps = makePromptStream();
		const written = [];
		let releaseWrite;
		const writeGate = new Promise((r) => { releaseWrite = r; });
		const pumping = pump(ps.stream, async (msg) => { written.push(text(msg)); await writeGate; });

		let acked = false;
		const ack = ps.push(userMessage([{ type: "text", text: "steer" }])).then(() => { acked = true; });

		// Write is in flight but not finished — the ack must not have resolved,
		// or a caller could release a tool result before the steer hits stdin.
		await new Promise((r) => setTimeout(r, 10));
		assert.deepStrictEqual(written, ["steer"]);
		assert.equal(acked, false, "ack resolved before the write completed");

		releaseWrite();
		await ack;
		assert.equal(acked, true);

		ps.end();
		await pumping;
	});

	it("delivers messages in push order and ends after draining", async () => {
		const ps = makePromptStream();
		const written = [];
		const pumping = pump(ps.stream, (msg) => { written.push(text(msg)); });

		await ps.push(userMessage([{ type: "text", text: "first" }]));
		await ps.push(userMessage([{ type: "text", text: "second" }]));
		ps.end();
		await pumping;

		assert.deepStrictEqual(written, ["first", "second"]);
	});

	it("carries priority through to the SDK message", () => {
		const msg = userMessage([{ type: "text", text: "steer" }], "next");
		assert.equal(msg.priority, "next");
		assert.equal(msg.parent_tool_use_id, null);
		// uuid is deliberately omitted — no dedup needed, and it would trigger a
		// session lookup in CC's stdin loop.
		assert.equal(msg.uuid, undefined);
	});

	it("rejects a push after end instead of hanging", async () => {
		const ps = makePromptStream();
		const pumping = pump(ps.stream, () => {});
		ps.end();
		await pumping;

		// A steer racing end-of-turn must fail fast — an unsettled ack would wedge
		// tool-result delivery forever.
		await assert.rejects(ps.push(userMessage([{ type: "text", text: "late" }])), /closed/);
	});

	it("fail settles queued and in-flight acks", async () => {
		const ps = makePromptStream();
		// Pump that never finishes its write — models a CLI that died mid-write.
		const pumping = pump(ps.stream, () => new Promise(() => {}));

		const inflight = ps.push(userMessage([{ type: "text", text: "inflight" }]));
		await new Promise((r) => setTimeout(r, 10));
		const queued = ps.push(userMessage([{ type: "text", text: "queued" }]));

		ps.fail(new Error("query ended"));
		await assert.rejects(inflight, /query ended/);
		await assert.rejects(queued, /query ended/);
		await assert.rejects(ps.push(userMessage([{ type: "text", text: "after" }])), /query ended/);
		void pumping;
	});

	it("settles the ack when the consumer abandons the stream", async () => {
		const ps = makePromptStream();
		// `break` in the pump calls gen.return(), which must run the generator's
		// finally and settle the parked ack.
		const pumping = (async () => {
			for await (const _msg of ps.stream) break;
		})();

		await assert.rejects(ps.push(userMessage([{ type: "text", text: "abandoned" }])), /closed/);
		await pumping;
	});

	it("rejects a push made after the consumer abandoned the stream", async () => {
		const ps = makePromptStream();
		const pumping = (async () => {
			for await (const _msg of ps.stream) break;
		})();
		await assert.rejects(ps.push(userMessage([{ type: "text", text: "abandoned" }])), /closed/);
		await pumping;

		// Nothing is left to drain the queue, so this has to reject rather than
		// park — a parked ack wedges tool-result delivery forever.
		await assert.rejects(
			Promise.race([
				ps.push(userMessage([{ type: "text", text: "later" }])),
				new Promise((_, r) => setTimeout(() => r(new Error("push hung")), 200)),
			]),
			/closed/,
		);
	});

	it("keeps the first failure rather than the last", async () => {
		const ps = makePromptStream();
		// fail() propagates into the generator, so the pump rejects too.
		const pumping = assert.rejects(pump(ps.stream, () => {}), /CLI exited with code 1/);
		const queued = ps.push(userMessage([{ type: "text", text: "queued" }]));

		// The provider's catch reports the real cause, then its finally fails the
		// stream again with a generic message.
		ps.fail(new Error("CLI exited with code 1"));
		ps.fail(new Error("query ended"));

		await assert.rejects(queued, /CLI exited with code 1/);
		await assert.rejects(ps.push(userMessage([{ type: "text", text: "after" }])), /CLI exited with code 1/);
		await pumping;
	});

	it("rejects the in-flight ack and every queued ack on consumer break", async () => {
		const ps = makePromptStream();
		const acks = ["inflight", "queued one", "queued two"].map((value) => ps.push(userMessage([{ type: "text", text: value }])));
		const settled = Promise.allSettled(acks);
		const written = [];
		for await (const msg of ps.stream) {
			written.push(text(msg));
			break;
		}
		assert.deepEqual(written, ["inflight"]);
		for (const result of await settled) {
			assert.equal(result.status, "rejected");
			assert.match(result.reason.message, /closed/);
		}
	});

	it("rejects every ack when the transport throws during a write", async () => {
		const ps = makePromptStream();
		const acks = ["inflight", "queued one", "queued two"].map((value) => ps.push(userMessage([{ type: "text", text: value }])));
		const settled = Promise.allSettled(acks);
		await assert.rejects(pump(ps.stream, () => { throw new Error("transport failed"); }), /transport failed/);
		for (const result of await settled) {
			assert.equal(result.status, "rejected");
			assert.match(result.reason.message, /closed/);
		}
	});

	it("return before the first pull rejects all queued acks", async () => {
		const ps = makePromptStream();
		const settled = Promise.allSettled(["one", "two"].map((value) => ps.push(userMessage([{ type: "text", text: value }]))));
		assert.deepEqual(await ps.stream.return(), { value: undefined, done: true });
		for (const result of await settled) {
			assert.equal(result.status, "rejected");
			assert.match(result.reason.message, /closed/);
		}
		await assert.rejects(ps.push(userMessage("later")), /closed/);
	});

	it("return wakes a consumer parked waiting for input", async () => {
		const ps = makePromptStream();
		const waiting = ps.stream.next();
		const closing = ps.stream.return();
		assert.deepEqual(await waiting, { value: undefined, done: true });
		assert.deepEqual(await closing, { value: undefined, done: true });
		await assert.rejects(ps.push(userMessage("later")), /closed/);
	});

	it("end drains all already queued acks before closing", async () => {
		const ps = makePromptStream();
		const acks = ["one", "two", "three"].map((value) => ps.push(userMessage([{ type: "text", text: value }])));
		ps.end();
		const written = [];
		await pump(ps.stream, (msg) => { written.push(text(msg)); });
		await Promise.all(acks);
		assert.deepEqual(written, ["one", "two", "three"]);
	});

	it("fail rejects all queued and in-flight acks without waiting for another pull", async () => {
		const ps = makePromptStream();
		const acks = ["inflight", "one", "two"].map((value) => ps.push(userMessage([{ type: "text", text: value }])));
		const settled = Promise.allSettled(acks);
		assert.equal(text((await ps.stream.next()).value), "inflight");
		const failure = new Error("CLI failed");
		ps.end();
		ps.fail(failure);
		for (const result of await settled) {
			assert.equal(result.status, "rejected");
			assert.equal(result.reason, failure);
		}
		await assert.rejects(ps.stream.next(), (error) => error === failure);
	});

	it("throw before the first pull rejects queued acks and closes future pushes", async () => {
		const ps = makePromptStream();
		const settled = Promise.allSettled(["one", "two"].map((value) => ps.push(userMessage([{ type: "text", text: value }]))));
		await assert.rejects(ps.stream.throw(new Error("consumer failed")), /consumer failed/);
		for (const result of await settled) {
			assert.equal(result.status, "rejected");
			assert.match(result.reason.message, /closed/);
		}
		await assert.rejects(ps.push(userMessage("later")), /closed/);
	});
});
