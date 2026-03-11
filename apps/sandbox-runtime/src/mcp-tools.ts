const SANDBOX_RUNTIME_BIN = "/usr/local/bin/sandbox-runtime.js";

export const MCP_SESSION_CWD_ENV = "SANDBOX_RUNTIME_MCP_CWD";

export function buildSessionMcpServers(cwd: string) {
	return [
		{
			name: "desktop",
			command: "bun",
			args: [SANDBOX_RUNTIME_BIN, "mcp", "desktop"],
			env: [],
		},
		{
			name: "code",
			command: "bun",
			args: [SANDBOX_RUNTIME_BIN, "mcp", "code"],
			env: [{ name: MCP_SESSION_CWD_ENV, value: cwd }],
		},
	];
}
