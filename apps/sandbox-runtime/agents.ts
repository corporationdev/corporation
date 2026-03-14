import fs from "node:fs";
import type { AcpAgentManifestEntry } from "@tendril/config/acp-agent-manifest";
import acpAgentManifest from "@tendril/config/acp-agent-manifest";

const HOME_DIR = process.env.HOME || "/home/user";

function expandHome(path: string): string {
	if (path === "$HOME") {
		return HOME_DIR;
	}
	if (path.startsWith("$HOME/")) {
		return `${HOME_DIR}/${path.slice("$HOME/".length)}`;
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

export function agentCommand(agent: string): string[] {
	const runtime = RUNTIME_AGENT_COMMANDS[agent];
	if (!runtime) {
		throw new Error(`Unknown ACP agent: ${agent}`);
	}

	return [
		expandHome(runtime.command),
		...(runtime.args ?? []).map((arg) => expandHome(arg)),
	];
}

export function assertAgentCommandReady(agent: string): void {
	const [command] = agentCommand(agent);
	if (!command) {
		throw new Error(`ACP agent ${agent} has no runtime command`);
	}

	fs.accessSync(command, fs.constants.X_OK);
}
