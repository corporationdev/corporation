import fs from "node:fs";
import type { AcpAgentManifestEntry } from "@corporation/config/acp-agent-manifest";
import acpAgentManifest from "@corporation/config/acp-agent-manifest";
import claudeCodeSettings from "./agent-configs/claude-code-settings.json";
import { log } from "./logging";

const SANDBOX_HOME_DIR = process.env.HOME || "/home/user";

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
		runtimeCommand: NonNullable<AcpAgentManifestEntry["runtimeCommand"]>;
	} => Boolean(agent.runtimeCommand)
);

const RUNTIME_AGENT_COMMANDS = Object.fromEntries(
	ACP_RUNTIME_AGENTS.map((agent) => [agent.id, agent.runtimeCommand])
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

export function describeAgentCommand(agent: string) {
	const command = agentCommand(agent);
	const executablePath = command[0] ?? null;
	if (!executablePath) {
		return {
			command,
			executablePath: null,
			exists: false,
		};
	}

	const summary: Record<string, unknown> = {
		command,
		executablePath,
		exists: false,
	};

	try {
		const stat = fs.lstatSync(executablePath);
		summary.exists = true;
		summary.mode = stat.mode;
		summary.size = stat.size;
		summary.isSymlink = stat.isSymbolicLink();
		summary.isFile = stat.isFile();
		if (stat.isSymbolicLink()) {
			summary.symlinkTarget = fs.readlinkSync(executablePath);
		}
		try {
			summary.realpath = fs.realpathSync(executablePath);
		} catch (error) {
			summary.realpathError =
				error instanceof Error ? error.message : String(error);
		}
		try {
			const content = fs.readFileSync(executablePath, "utf8");
			summary.firstLine = content.split("\n", 1)[0] ?? "";
		} catch (error) {
			summary.firstLineError =
				error instanceof Error ? error.message : String(error);
		}
		try {
			fs.accessSync(executablePath, fs.constants.X_OK);
			summary.executable = true;
		} catch {
			summary.executable = false;
		}
	} catch (error) {
		summary.error = error instanceof Error ? error.message : String(error);
	}

	return summary;
}

export function getAgentCommandReadiness(agent: string) {
	const diagnostics = describeAgentCommand(agent);
	const ready = diagnostics.exists === true && diagnostics.executable === true;
	return {
		ready,
		diagnostics,
	};
}

/** Map of agent name -> array of { path, content } config files to write before spawning. */
const AGENT_CONFIGS: Record<string, { path: string; content: string }[]> = {
	"claude-acp": [
		{
			path: `${SANDBOX_HOME_DIR}/.claude/settings.json`,
			content: JSON.stringify(claudeCodeSettings),
		},
	],
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
