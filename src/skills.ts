// MCP naming constants shared by the provider path and the prompt projection.
// OMP's tools reach Claude Code through one in-process MCP server, so Claude
// sees them as mcp__custom-tools__<name>.

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
