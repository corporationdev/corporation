import fs from "node:fs";
import type { AcpAgentManifestEntry } from "@corporation/config/acp-agent-manifest";
import acpAgentManifest from "@corporation/config/acp-agent-manifest";
import claudeCodeSettings from "./agent-configs/claude-code-settings.json";
import { log } from "./logging";

const SANDBOX_HOME_DIR = process.env.HOME || "/home/user";

function stringEnv(): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string"
		)
	);
}

function expandHome(path: string) {
	if (path.startsWith("$HOME/")) {
		return `${SANDBOX_HOME_DIR}/${path.slice("$HOME/".length)}`;
	}
	if (path === "$HOME") {
		return SANDBOX_HOME_DIR;
	}
	return path;
}

const RUNTIME_AGENT_COMMANDS = Object.fromEntries(
	acpAgentManifest
		.filter((agent) => agent.runtimeId && agent.runtimeCommand)
		.map((agent) => [agent.runtimeId, agent.runtimeCommand])
) as Record<string, NonNullable<AcpAgentManifestEntry["runtimeCommand"]>>;

export function agentCommand(agent: string): string[] {
	const runtime = RUNTIME_AGENT_COMMANDS[agent];
	if (!runtime) {
		throw new Error(`Unknown agent: ${agent}`);
	}

	return [
		expandHome(runtime.command),
		...(runtime.args ?? []).map((arg: string) => expandHome(arg)),
	];
}

export function agentEnv(agent: string): Record<string, string> {
	const env = stringEnv();
	const runtime = RUNTIME_AGENT_COMMANDS[agent];
	const basePath = env.PATH ?? process.env.PATH ?? "";
	env.PATH = `${SANDBOX_HOME_DIR}/.local/bin:${basePath}`;

	if (runtime?.env) {
		for (const [key, value] of Object.entries(runtime.env)) {
			env[key] = value;
		}
	}

	if (agent !== "claude") {
		return env as Record<string, string>;
	}

	// Claude Code ACP consumes credentials from the process environment.
	// If an OAuth token is available, prefer it and omit the API key.
	if (env.CLAUDE_CODE_OAUTH_TOKEN) {
		env.ANTHROPIC_API_KEY = undefined;
	}

	return Object.fromEntries(
		Object.entries(env).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string"
		)
	);
}

/** Map of agent name -> array of { path, content } config files to write before spawning. */
const AGENT_CONFIGS: Record<string, { path: string; content: string }[]> = {
	claude: [
		{
			path: `${SANDBOX_HOME_DIR}/.claude/settings.json`,
			content: JSON.stringify(claudeCodeSettings),
		},
	],
};

export function writeAgentConfigs(agent: string): void {
	const configs = AGENT_CONFIGS[agent];
	if (!configs) {
		return;
	}
	for (const { path: filePath, content } of configs) {
		const dir = filePath.substring(0, filePath.lastIndexOf("/"));
		if (dir) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(filePath, content);
		log("info", `Wrote agent config: ${filePath}`);
	}
}
