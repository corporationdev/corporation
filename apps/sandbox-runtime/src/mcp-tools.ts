export const MCP_SESSION_CWD_ENV = "SANDBOX_RUNTIME_MCP_CWD";
const DISABLE_SESSION_MCP_ENV = "SANDBOX_RUNTIME_DISABLE_SESSION_MCP";

function getRuntimeEntrypointArgs(subcommand: "browser" | "desktop" | "code") {
	const runtimeEntrypoint = process.argv[1];
	if (!runtimeEntrypoint) {
		throw new Error("sandbox-runtime entrypoint is not available");
	}

	return [runtimeEntrypoint, "mcp", subcommand];
}

export function buildSessionMcpServers(cwd: string) {
	if (process.env[DISABLE_SESSION_MCP_ENV] === "1") {
		return [];
	}

	return [
		{
			name: "browser",
			command: process.execPath,
			args: getRuntimeEntrypointArgs("browser"),
			env: [],
		},
		{
			name: "desktop",
			command: process.execPath,
			args: getRuntimeEntrypointArgs("desktop"),
			env: [],
		},
		{
			name: "code",
			command: process.execPath,
			args: getRuntimeEntrypointArgs("code"),
			env: [{ name: MCP_SESSION_CWD_ENV, value: cwd }],
		},
	];
}
