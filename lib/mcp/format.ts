export function mcpJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
export function mcpError(error: unknown) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : "MCP tool failed" }]
  };
}
