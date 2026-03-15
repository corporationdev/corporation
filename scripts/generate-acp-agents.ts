// Fetches the ACP agent registry and generates the shared agent manifest.
//
// Usage:
//   bun scripts/generate-acp-agents.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	type AgentCredentialBundle,
	type AgentNativeCliInstall,
	SUPPORTED_ACP_AGENTS,
	type SupportedAcpAgentConfig,
} from "../packages/config/src/acp-supported-agents";

const REGISTRY_URL =
	"https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const SHARED_OUTPUT_PATH = resolve(
	import.meta.dirname,
	"../packages/config/src/acp-agent-manifest.json"
);

const SCOPED_PACKAGE_SPEC_RE = /^(@[^/]+\/[^@]+)(?:@(.+))?$/;
const UNSCOPED_PACKAGE_SPEC_RE = /^([^@]+)(?:@(.+))?$/;

type GeneratedNativeCli = {
	displayName: string;
	executableNames: string[];
	install: AgentNativeCliInstall;
};

type GeneratedAdapterInstall =
	| {
			kind: "npm";
			package: string;
			executableName: string;
			args?: string[];
			env?: Record<string, string>;
	  }
	| {
			kind: "binary";
			platforms: Record<
				string,
				{
					archive: string;
					cmd: string;
					args?: string[];
				}
			>;
	  }
	| {
			kind: "uvx";
			package: string;
			args?: string[];
	  };

type GeneratedAcpAdapter = {
	displayName: string;
	version: string | null;
	install: GeneratedAdapterInstall;
};

type GeneratedAgent = {
	id: string;
	name: string;
	description: string;
	icon: string | null;
	repository?: string;
	authors?: string[];
	license?: string;
	nativeCli: GeneratedNativeCli;
	acpAdapter: GeneratedAcpAdapter;
	credentialBundle: AgentCredentialBundle;
};

type RegistryAgent = {
	id: string;
	name: string;
	description: string;
	icon?: string;
	version?: string;
	repository?: string;
	authors?: string[];
	license?: string;
	distribution: {
		binary?: Record<
			string,
			{
				archive: string;
				cmd: string;
				args?: string[];
			}
		>;
		npx?: {
			package: string;
			args?: string[];
			env?: Record<string, string>;
		};
		uvx?: {
			package: string;
			args?: string[];
		};
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

function assertString(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new Error(`Invalid ACP registry: expected ${label} to be a string`);
	}
	return value;
}

function assertOptionalStringArray(
	value: unknown,
	label: string
): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(
			`Invalid ACP registry: expected ${label} to be an array of strings`
		);
	}
	return value;
}

function parseRegistryAgent(value: unknown): RegistryAgent {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid ACP registry: agent entry must be an object");
	}

	const agent = value as Record<string, unknown>;
	const distribution = agent.distribution;
	if (!distribution || typeof distribution !== "object") {
		throw new Error(
			`Invalid ACP registry: agent ${String(agent.id ?? "<unknown>")} is missing distribution metadata`
		);
	}

	return {
		...agent,
		id: assertString(agent.id, "agent.id"),
		name: assertString(agent.name, "agent.name"),
		description: assertString(agent.description, "agent.description"),
		icon:
			agent.icon === undefined
				? undefined
				: assertString(agent.icon, "agent.icon"),
		version:
			agent.version === undefined
				? undefined
				: assertString(agent.version, "agent.version"),
		repository:
			agent.repository === undefined
				? undefined
				: assertString(agent.repository, "agent.repository"),
		authors: assertOptionalStringArray(agent.authors, "agent.authors"),
		license:
			agent.license === undefined
				? undefined
				: assertString(agent.license, "agent.license"),
		distribution: distribution as RegistryAgent["distribution"],
	};
}

function parseRegistry(value: unknown): { agents: RegistryAgent[] } {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid ACP registry payload");
	}

	const payload = value as Record<string, unknown>;
	if (!Array.isArray(payload.agents)) {
		throw new Error("Invalid ACP registry: expected agents to be an array");
	}

	return {
		agents: payload.agents.map(parseRegistryAgent),
	};
}

const PINNED_ORDER = [
	"claude-acp",
	"codex-acp",
	"opencode",
	"cursor",
	"gemini",
	"github-copilot-cli",
	"amp-acp",
	"pi-acp",
	"factory-droid",
];
const BLOCKED_AGENT_IDS = new Set([
	"nova",
	"minion-code",
	"crow-cli",
	"corust-agent",
	"codebuddy-code",
	"fast-agent",
]);

function packageSpecSchema(value: string) {
	const scopedMatch = value.match(SCOPED_PACKAGE_SPEC_RE);
	if (scopedMatch) {
		return {
			name: scopedMatch[1],
			version: scopedMatch[2] ?? null,
		};
	}

	const unscopedMatch = value.match(UNSCOPED_PACKAGE_SPEC_RE);
	if (!unscopedMatch) {
		throw new Error(`Invalid package spec: ${value}`);
	}
	return {
		name: unscopedMatch[1],
		version: unscopedMatch[2] ?? null,
	};
}

function inferExecutableName(packageName: string) {
	const lastSegment = packageName.split("/").at(-1) ?? packageName;
	if (lastSegment.endsWith("-cli")) {
		return lastSegment.slice(0, -4);
	}
	return lastSegment;
}

function buildAdapterInstall(
	agent: RegistryAgent,
	config: SupportedAcpAgentConfig
): GeneratedAdapterInstall {
	if (agent.distribution.binary) {
		return {
			kind: "binary",
			platforms: agent.distribution.binary,
		};
	}

	if (agent.distribution.npx) {
		const { name } = packageSpecSchema(agent.distribution.npx.package);
		return {
			kind: "npm",
			package: agent.distribution.npx.package,
			executableName:
				config.acpAdapter.executableName ?? inferExecutableName(name),
			...(agent.distribution.npx.args
				? { args: agent.distribution.npx.args }
				: {}),
			...(agent.distribution.npx.env
				? { env: agent.distribution.npx.env }
				: {}),
		};
	}

	if (agent.distribution.uvx) {
		return {
			kind: "uvx",
			package: agent.distribution.uvx.package,
			...(agent.distribution.uvx.args
				? { args: agent.distribution.uvx.args }
				: {}),
		};
	}

	throw new Error(`Supported agent ${agent.id} has no installable ACP adapter`);
}

function toGeneratedAgent(
	agent: RegistryAgent,
	config: SupportedAcpAgentConfig
): GeneratedAgent {
	return {
		id: agent.id,
		name: agent.name,
		description: agent.description,
		icon: agent.icon ?? null,
		...(agent.repository ? { repository: agent.repository } : {}),
		...(agent.authors ? { authors: agent.authors } : {}),
		...(agent.license ? { license: agent.license } : {}),
		nativeCli: config.nativeCli,
		acpAdapter: {
			displayName: `${agent.name} ACP Adapter`,
			version: agent.version ?? null,
			install: buildAdapterInstall(agent, config),
		},
		credentialBundle: config.credentialBundle,
	};
}

function sortAgents(left: GeneratedAgent, right: GeneratedAgent) {
	const leftPinnedIndex = PINNED_ORDER.indexOf(left.id);
	const rightPinnedIndex = PINNED_ORDER.indexOf(right.id);
	if (leftPinnedIndex !== -1 && rightPinnedIndex !== -1) {
		return leftPinnedIndex - rightPinnedIndex;
	}
	if (leftPinnedIndex !== -1) {
		return -1;
	}
	if (rightPinnedIndex !== -1) {
		return 1;
	}
	return left.name.localeCompare(right.name);
}

async function main() {
	console.log("Fetching ACP registry...");
	const response = await fetch(REGISTRY_URL);
	if (!response.ok) {
		throw new Error(`Failed to fetch registry: ${response.status}`);
	}

	const data = parseRegistry(await response.json());
	const registryAgentsById = new Map(
		data.agents
			.filter((agent) => !BLOCKED_AGENT_IDS.has(agent.id))
			.map((agent) => [agent.id, agent])
	);
	const agents = SUPPORTED_ACP_AGENTS.map((config) => {
		const registryAgent = registryAgentsById.get(config.id);
		if (!registryAgent) {
			throw new Error(`Missing supported agent ${config.id} in ACP registry`);
		}
		return toGeneratedAgent(registryAgent, config);
	}).sort(sortAgents);
	const serialized = `${JSON.stringify(agents, null, "  ")}\n`;

	mkdirSync(dirname(SHARED_OUTPUT_PATH), { recursive: true });
	writeFileSync(SHARED_OUTPUT_PATH, serialized);
	console.log(`Wrote ${agents.length} agents to ${SHARED_OUTPUT_PATH}`);

	const result = Bun.spawnSync(
		["bunx", "@biomejs/biome", "format", "--write", SHARED_OUTPUT_PATH],
		{
			stdout: "pipe",
			stderr: "pipe",
		}
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to format ${SHARED_OUTPUT_PATH}: ${new TextDecoder().decode(result.stderr)}`
		);
	}
}

main();
