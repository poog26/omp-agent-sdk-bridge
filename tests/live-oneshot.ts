// Live check of the one-shot path (compaction summaries, titles, recaps): registers
// the extension against a stub OMP API and calls its streamSimple with a tool-less
// summarizer context on the same sessionId as a live conversation. Spends a little
// real usage through Claude Code's login.
//
//   bun tests/live-oneshot.ts [model]      (default claude-haiku-5-5)

import extension from "../src/index.ts";

const registered: { streamSimple?: (model: any, context: any, options?: any) => any; models?: any[] } = {};
const stubPi = {
	on() {},
	registerTool() {},
	registerCommand() {},
	registerProvider(_name: string, config: any) { Object.assign(registered, config); },
};

// This harness intentionally supplies only the extension methods it exercises.
const extensionApi = stubPi as unknown as Parameters<typeof extension>[0];
await extension(extensionApi);

const modelId = process.argv[2] ?? "claude-haiku-5-5";
const model = registered.models?.find((m) => m.id === modelId);
if (!model || !registered.streamSimple) {
	console.error(`FAIL: provider not registered or model ${modelId} missing`);
	process.exit(1);
}

const context = {
	systemPrompt: ["You are a conversation summarizer. Output only the summary."],
	messages: [{ role: "user", content: "Summarize in one short sentence: The user asked to remember the codeword PERIWINKLE and the assistant said noted.", timestamp: Date.now() }],
};
const stream = registered.streamSimple({ ...model, provider: "claude-bridge", api: "claude-bridge" }, context, {
	sessionId: "live-oneshot-session",
	reasoning: "low",
});
const result = await stream.result();
const text = (result.content ?? []).map((b: any) => b.text ?? "").join("");
console.log(`stopReason=${result.stopReason}${result.errorMessage ? ` error=${result.errorMessage}` : ""}`);
console.log(`summary: ${text}`);
const ok = result.stopReason === "stop" && /periwinkle/i.test(text);
console.log(ok ? "ok   one-shot path returned a summary" : "FAIL one-shot path");
process.exit(ok ? 0 : 1);
