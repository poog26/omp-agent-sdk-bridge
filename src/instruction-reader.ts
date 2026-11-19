// AskClaude's native tools cannot resolve OMP's skill:// and rule:// URLs.
// Expose only those read-only schemes, never the router's mutation-capable schemes.
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { getActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { getActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { z } from "zod";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";

export const INSTRUCTION_READ_TOOL = `${MCP_TOOL_PREFIX}read`;

/** A resolved resource as one MCP content block. An MCP server can serve a skill:// URL as bytes (OMP 19+). */
export function resourceBlock(path: string, { content, contentType }: { content: string | Buffer; contentType: string }) {
	if (typeof content === "string") return { type: "text" as const, text: content };
	if (contentType.startsWith("image/")) return { type: "image" as const, data: content.toString("base64"), mimeType: contentType };
	return { type: "text" as const, text: `${path} is a binary file (${contentType}, ${content.length} bytes) and cannot be shown as text.` };
}

export function instructionReader(cwd: string, signal?: AbortSignal) {
	const context = { cwd, signal, skills: [...getActiveSkills()], rules: [...getActiveRules()] };
	const schema = z.object({ path: z.string() });
	return createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: "1.0.0",
		tools: [{
			name: "read",
			description: "Read OMP skill:// and rule:// instructions and skill reference files. No other URLs or filesystem paths are accepted.",
			inputSchema: schema,
			handler: async (args) => {
				try {
					const { path } = schema.parse(args);
					if (!/^(skill|rule):\/\//.test(path)) throw new Error("Only skill:// and rule:// instruction URLs are allowed");
					if (signal?.aborted) throw new Error("Operation aborted");
					return { content: [resourceBlock(path, await InternalUrlRouter.instance().resolve(path, context))] };
				} catch (error) {
					return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
				}
			},
		}],
	});
}
