// AskClaude's native tools cannot resolve OMP's skill:// and rule:// URLs.
// Expose only those read-only schemes, never the router's mutation-capable schemes.
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { getActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { getActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { z } from "zod";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";

export const INSTRUCTION_READ_TOOL = `${MCP_TOOL_PREFIX}read`;

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
					const resource = await InternalUrlRouter.instance().resolve(path, context);
					return { content: [{ type: "text" as const, text: resource.content }] };
				} catch (error) {
					return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
				}
			},
		}],
	});
}
