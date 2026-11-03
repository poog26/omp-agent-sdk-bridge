// OMP tool schema (JSON Schema) → Zod, as createSdkMcpServer requires.
//
// OMP hands providers each tool's wire JSON Schema. The Agent SDK only accepts
// Zod (it detects Zod via `~standard` / `_def` / `_zod` and silently downgrades
// anything else to `{type: "object", properties: {}}`), and the MCP server
// re-serializes that Zod with `z.toJSONSchema` for tools/list.
//
// Rebuilding the schema node by node in Zod was lossy (nested objects, unions,
// const, $ref all flattened), so instead every property is `z.unknown()` carrying
// its original JSON Schema as metadata: `z.toJSONSchema` merges registry metadata
// into the output, so Claude sees each property exactly as OMP declared it.
//
// Validation is deliberately permissive. Every property is optional to Zod and
// only the root's metadata restores `required`. The MCP server validates
// arguments before calling a handler, and a call it rejects never reaches its
// handler, which would leave that tool call without a result and shift the
// handler ↔ toolCallId pairing. OMP validates the arguments itself and returns
// a proper error to Claude, so nothing is lost by letting every call through.
//
// If this breaks after an SDK or Zod update, check that tools/list still merges
// `.meta()` into the emitted schema (tests/unit-tool-schema.mjs covers it).

import { z } from "zod";

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchema {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

// Zod treats a metadata `id` as a registry id and hoists the node into $defs;
// draft-04 `id` carries no meaning for the model, so it is dropped.
function asMeta(schema: JsonSchema): JsonSchema {
	const { id: _id, ...rest } = schema;
	return rest;
}

/**
 * A root union of object branches (`{anyOf: [{properties…}, …]}`) has no top-level
 * properties, and the Messages API rejects combinators at the `input_schema` root.
 * Merge the branches into one object: each key keeps its first declaration, keys
 * that are `const` in several branches become an `enum`, and only keys required by
 * every branch stay required.
 */
function mergeRootUnion(schema: JsonSchema): JsonSchema | null {
	const branches = (schema.anyOf ?? schema.oneOf) as unknown;
	if (!Array.isArray(branches) || !branches.length || !branches.every((b) => isRecord(b) && isRecord(b.properties))) return null;
	const properties: Record<string, JsonSchema> = {};
	const consts = new Map<string, unknown[]>();
	let required: Set<string> | null = null;
	for (const branch of branches as JsonSchema[]) {
		for (const [key, prop] of Object.entries(branch.properties as Record<string, unknown>)) {
			if (!isRecord(prop)) continue;
			if ("const" in prop) consts.set(key, [...(consts.get(key) ?? []), prop.const]);
			properties[key] ??= prop;
		}
		const req = new Set(Array.isArray(branch.required) ? branch.required as string[] : []);
		required = required ? new Set([...required].filter((k) => req.has(k))) : req;
	}
	for (const [key, values] of consts) {
		if (values.length < 2) continue;
		const { const: _c, ...rest } = properties[key];
		properties[key] = { ...rest, enum: [...new Set(values)] };
	}
	const { anyOf: _a, oneOf: _o, ...rest } = schema;
	return { ...rest, type: "object", properties, required: [...(required ?? [])] };
}

/** Zod object for createSdkMcpServer that lists exactly `schema` and accepts any arguments. */
export function jsonSchemaToZodSchema(schema: unknown): z.ZodTypeAny {
	let root: JsonSchema = isRecord(schema) ? schema : {};
	if (!isRecord(root.properties)) root = mergeRootUnion(root) ?? { ...root, properties: {} };
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(root.properties as Record<string, unknown>)) {
		shape[key] = z.unknown().meta(isRecord(prop) ? asMeta(prop) : {}).optional();
	}
	const rootMeta: JsonSchema = { required: Array.isArray(root.required) ? root.required : [] };
	for (const key of ["$defs", "definitions", "additionalProperties", "description"]) {
		if (root[key] !== undefined) rootMeta[key] = root[key];
	}
	return z.object(shape).meta(rootMeta);
}
