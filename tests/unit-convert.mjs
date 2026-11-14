import test from "node:test";
import assert from "node:assert/strict";
import { convertPiMessages } from "../src/convert.ts";

const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
const convertedImage = { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } };

function convertResult(content, isError = false) {
	return convertPiMessages([
		{ role: "assistant", content: [{ type: "toolCall", id: "call:1", name: "read", arguments: { path: "image.png" } }] },
		{ role: "toolResult", toolCallId: "call:1", content, isError },
	]);
}

test("tool results preserve interleaved text and base64 images with matching sanitized IDs", () => {
	const { anthropicMessages, sanitizedIds } = convertResult([
		{ type: "text", text: "before the image" }, image,
		{ type: "text", text: "after the image" },
	], true);
	assert.equal(sanitizedIds.get("call:1"), "call_1");
	assert.equal(anthropicMessages[0].content[0].id, "call_1");
	assert.deepEqual(anthropicMessages[1], {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "call_1", is_error: true, content: [
			{ type: "text", text: "before the image" }, convertedImage,
			{ type: "text", text: "after the image" },
		] }],
	});
});

test("image-only tool results remain visible to the model", () => {
	const { anthropicMessages } = convertResult([image]);
	assert.deepEqual(anthropicMessages[1].content[0].content, [convertedImage]);
	assert.equal(anthropicMessages[1].content[0].is_error, false);
});

test("text-only and empty tool results retain their supported string shape", () => {
	for (const [input, expected] of [
		["plain text", "plain text"],
		[[{ type: "text", text: "first" }, { type: "text", text: "second" }], "first\nsecond"],
		[[], ""],
		["", ""],
	]) {
		assert.equal(convertResult(input).anthropicMessages[1].content[0].content, expected);
	}
});
