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

const ACP_RUNTIME_AGENTS = acpAgentManifest.filter(
	(
		agent
	): agent is AcpAgentManifestEntry & {
		runtimeId: string;
		runtimeCommand: NonNullable<AcpAgentManifestEntry["runtimeCommand"]>;
	} => Boolean(agent.runtimeId && agent.runtimeCommand)
);

const RUNTIME_AGENT_COMMANDS = Object.fromEntries(
	ACP_RUNTIME_AGENTS.map((agent) => [agent.runtimeId, agent.runtimeCommand])
) as Record<string, NonNullable<AcpAgentManifestEntry["runtimeCommand"]>>;

const RUNTIME_AGENTS_BY_MANIFEST_ID = Object.fromEntries(
	ACP_RUNTIME_AGENTS.map((agent) => [agent.id, agent])
) as Record<string, (typeof ACP_RUNTIME_AGENTS)[number]>;

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

	return env as Record<string, string>;
}

export function runtimeAgentEntry(id: string) {
	return RUNTIME_AGENTS_BY_MANIFEST_ID[id] ?? null;
}

export function runtimeAgentEntries(ids?: string[]) {
	if (!ids || ids.length === 0) {
		return ACP_RUNTIME_AGENTS;
	}

	return ids
		.map((id) => runtimeAgentEntry(id))
		.filter(
			(agent): agent is (typeof ACP_RUNTIME_AGENTS)[number] => agent !== null
		);
}

export function isAgentInstalled(agent: string): boolean {
	const [command] = agentCommand(agent);
	if (!command) {
		return false;
	}

	try {
		fs.accessSync(command, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
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
