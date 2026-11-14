import test from "node:test";
import assert from "node:assert/strict";

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { jsonSchemaToZodSchema } from "../src/typebox-to-zod.ts";

// Runs the schema through the SDK's own MCP server, so this checks what Claude
// Code actually lists and which calls reach a handler, not just our Zod object.
async function serve(parameters) {
	const calls = [];
	const server = createSdkMcpServer({
		name: "t", version: "1.0.0",
		tools: [{ name: "x", description: "d", inputSchema: jsonSchemaToZodSchema(parameters), handler: async (args) => {
			calls.push(args);
			return { content: [{ type: "text", text: "ok" }] };
		} }],
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.instance.connect(serverSide);
	const client = new Client({ name: "c", version: "1.0.0" });
	await client.connect(clientSide);
	const { tools } = await client.listTools();
	return { listed: tools[0]?.inputSchema, call: (args) => client.callTool({ name: "x", arguments: args }), calls };
}

const nested = {
	type: "object",
	properties: {
		chain: {
			type: "array",
			description: "helper calls",
			items: { type: "object", properties: { method: { type: "string" }, args: { type: "array", items: {} } }, required: ["method", "args"], additionalProperties: false },
		},
		mode: { anyOf: [{ const: "fast" }, { type: "number", minimum: 1 }], description: "speed" },
		target: { $ref: "#/$defs/Target" },
	},
	required: ["chain"],
	additionalProperties: false,
	$defs: { Target: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } } },
};

test("nested properties, unions, const and $refs are listed exactly as OMP declared them", async () => {
	const { listed } = await serve(nested);
	assert.deepEqual(listed.properties.chain, nested.properties.chain);
	assert.deepEqual(listed.properties.mode, nested.properties.mode);
	// The MCP server emits draft-07, which spells a $ref as a one-entry allOf.
	assert.deepEqual(listed.properties.target, { allOf: [{ $ref: "#/$defs/Target" }] });
	assert.deepEqual(listed.required, ["chain"]);
	assert.equal(listed.additionalProperties, false);
	assert.deepEqual(listed.$defs, nested.$defs);
});

test("every call reaches the handler, so OMP validates it and the toolCallId pairing holds", async () => {
	const { call, calls } = await serve(nested);
	for (const args of [{}, { chain: "not an array" }, { chain: [], mode: "slow", extra: 1 }]) {
		const result = await call(args);
		assert.ok(!result.isError, JSON.stringify(result));
	}
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[1], { chain: "not an array" });
});

test("a root union of object branches is merged into one object", async () => {
	const { listed } = await serve({
		anyOf: [
			{ type: "object", properties: { action: { const: "run" }, code: { type: "string" } }, required: ["action", "code"] },
			{ type: "object", properties: { action: { const: "close" } }, required: ["action"] },
		],
	});
	assert.equal(listed.type, "object");
	assert.equal(listed.anyOf, undefined);
	assert.deepEqual(listed.properties.action, { anyOf: [{ const: "run" }, { const: "close" }] });
	assert.deepEqual(listed.properties.code, { type: "string" });
	assert.deepEqual(listed.required, ["action"]);
});

for (const combinator of ["anyOf", "oneOf"]) {
	test(`root ${combinator} preserves overlapping property alternatives without a root combinator`, async () => {
		const alternatives = [
			{ const: "auto", description: "automatic mode" },
			{ type: "number", minimum: 1, maximum: 8 },
			{ type: "array", items: { type: "string" }, minItems: 1 },
			{ enum: ["fast", "slow"] },
		];
		const { listed, call, calls } = await serve({
			[combinator]: alternatives.map((mode) => ({
				type: "object", properties: { mode }, required: ["mode"],
			})),
		});
		assert.equal(listed.type, "object");
		assert.equal(listed.anyOf, undefined);
		assert.equal(listed.oneOf, undefined);
		assert.deepEqual(listed.properties.mode, { anyOf: alternatives });
		assert.deepEqual(listed.required, ["mode"]);
		for (const mode of ["auto", 3, ["x"], "fast"]) await call({ mode });
		assert.deepEqual(calls, [{ mode: "auto" }, { mode: 3 }, { mode: ["x"] }, { mode: "fast" }]);
	});
}

test("a schema without properties still lists an empty object", async () => {
	const { listed } = await serve(undefined);
	assert.equal(listed.type, "object");
	assert.deepEqual(listed.properties ?? {}, {});
});
