import fs from "node:fs";
import path from "node:path";
import type { AcpAgentManifestEntry } from "@tendril/config/acp-agent-manifest";
import acpAgentManifest from "@tendril/config/acp-agent-manifest";

function resolveAdapterCommand(agent: AcpAgentManifestEntry): string[] {
	const install = agent.acpAdapter.install;
	if (
		install.kind === "npm" &&
		"executableName" in install &&
		typeof install.executableName === "string"
	) {
		return [install.executableName];
	}

	if (install.kind === "binary") {
		const os =
			process.platform === "win32"
				? "windows"
				: process.platform === "darwin"
					? "darwin"
					: process.platform;
		const arch =
			process.arch === "arm64"
				? "aarch64"
				: process.arch === "x64"
					? "x86_64"
					: process.arch;
		const platform = `${os}-${arch}`;
		const platforms = install.platforms as Record<
			string,
			{
				archive: string;
				cmd: string;
			}
		>;
		const binary = platforms[platform];
		if (!binary) {
			throw new Error(`ACP agent ${agent.id} does not support platform ${platform}`);
		}
		return [path.basename(binary.cmd)];
	}

	throw new Error(`ACP agent ${agent.id} does not define an executable`);
}

const RUNTIME_AGENT_COMMANDS = Object.fromEntries(
	acpAgentManifest.map((agent) => [agent.id, resolveAdapterCommand(agent)])
) as Record<string, string[]>;

export function agentCommand(agent: string): string[] {
	const runtime = RUNTIME_AGENT_COMMANDS[agent];
	if (!runtime) {
		throw new Error(`Unknown ACP agent: ${agent}`);
	}

	return runtime;
}

export function assertAgentCommandReady(agent: string): void {
	const [command] = agentCommand(agent);
	if (!command) {
		throw new Error(`ACP agent ${agent} has no runtime command`);
	}

	fs.accessSync(command, fs.constants.X_OK);
}
