// Fetches the ACP agent registry and generates the shared agent manifest.
//
// Usage:
//   bun scripts/generate-acp-agents.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	type AgentCredentialBundle,
	SUPPORTED_ACP_AGENTS,
	type SupportedAcpAgentConfig,
} from "../packages/config/src/acp-supported-agents";

const REGISTRY_URL =
	"https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const SHARED_OUTPUT_PATH = resolve(
	import.meta.dirname,
	"../packages/config/src/acp-agent-manifest.json"
);

const SANDBOX_HOME = "$HOME";
const USER_BIN_DIR = `${SANDBOX_HOME}/.local/bin`;
const NATIVE_ROOT_DIR = `${SANDBOX_HOME}/.local/share/corporation/native`;
const ACP_ROOT_DIR = `${SANDBOX_HOME}/.local/share/corporation/acp`;
const ACP_PLATFORM = "linux-x86_64";
const SCOPED_PACKAGE_SPEC_RE = /^(@[^/]+\/[^@]+)(?:@(.+))?$/;
const UNSCOPED_PACKAGE_SPEC_RE = /^([^@]+)(?:@(.+))?$/;
const WINDOWS_SUFFIX_RE = /\.exe$/i;

type LegacyManualAgentConfig = {
	nativeInstallCommand?: string | null;
	runtimeCommandOverride?: {
		command: string;
		args?: string[];
		env?: Record<string, string>;
	};
	acpInstallStrategy?: "distribution" | "native";
	acpExecutableName?: string;
	installSource?: string;
	credentialBundle?: AgentCredentialBundle | null;
};

type GeneratedRuntimeCommand = {
	command: string;
	args: string[];
	env?: Record<string, string>;
};

type GeneratedAgent = RegistryAgent & {
	icon: string | null;
	nativeInstallCommand: string | null;
	acpInstallCommand: string | null;
	runtimeCommand: GeneratedRuntimeCommand | null;
	installCommand: string | null;
	installSource: string;
	credentialBundle: AgentCredentialBundle;
};

// Legacy manual config retained for reference only. The generator no longer
// uses this map; supported agents now come exclusively from
// packages/config/src/acp-supported-agents.ts.
export const LEGACY_MANUAL_AGENT_CONFIG: Record<
	string,
	LegacyManualAgentConfig
> = {
	"claude-acp": {
		nativeInstallCommand:
			'npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code',
		acpInstallStrategy: "distribution",
		acpExecutableName: "claude-agent-acp",
		installSource: "https://docs.anthropic.com/en/docs/claude-code/setup",
		credentialBundle: {
			schemaVersion: 1,
			paths: [
				{ path: "$HOME/.claude.json", kind: "file", required: true },
				{
					path: "$HOME/.claude/.credentials.json",
					kind: "file",
					required: true,
				},
			],
		},
	},
	"codex-acp": {
		nativeInstallCommand:
			'npm install -g --prefix "$HOME/.local" @openai/codex',
		acpInstallStrategy: "distribution",
		installSource: "https://github.com/openai/codex",
		credentialBundle: {
			schemaVersion: 1,
			paths: [{ path: "$HOME/.codex/auth.json", kind: "file", required: true }],
		},
	},
	opencode: {
		acpInstallStrategy: "native",
		installSource: "https://opencode.ai/docs",
	},
	cursor: {
		acpInstallStrategy: "native",
		installSource: "https://docs.cursor.com/en/cli/overview",
	},
	gemini: {
		nativeInstallCommand:
			'npm install -g --prefix "$HOME/.local" @google/gemini-cli',
		runtimeCommandOverride: {
			command: `${USER_BIN_DIR}/gemini`,
			args: ["--experimental-acp"],
		},
		acpInstallStrategy: "native",
		installSource: "https://github.com/google-gemini/gemini-cli",
	},
	"github-copilot-cli": {
		nativeInstallCommand:
			'npm install -g --prefix "$HOME/.local" @github/copilot',
		runtimeCommandOverride: {
			command: `${USER_BIN_DIR}/copilot`,
			args: ["--acp"],
		},
		acpInstallStrategy: "native",
		installSource: "https://github.com/github/copilot-cli",
	},
	"amp-acp": {
		nativeInstallCommand: "curl -fsSL https://ampcode.com/install.sh | bash",
		acpInstallStrategy: "distribution",
		installSource: "https://ampcode.com",
	},
	auggie: {
		nativeInstallCommand:
			'npm install -g --prefix "$HOME/.local" @augmentcode/auggie',
		runtimeCommandOverride: {
			command: `${USER_BIN_DIR}/auggie`,
			args: ["--acp"],
			env: {
				AUGMENT_DISABLE_AUTO_UPDATE: "1",
			},
		},
		acpInstallStrategy: "native",
		installSource:
			"https://www.augmentcode.com/guides/getting-started/installation",
	},
	"pi-acp": {
		nativeInstallCommand:
			'npm install -g --prefix "$HOME/.local" @mariozechner/pi-coding-agent',
		acpInstallStrategy: "distribution",
		acpExecutableName: "pi-acp",
		installSource:
			"https://github.com/badlogic/pi-mono/tree/master/packages/coding-agent",
	},
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

function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellDoubleQuote(value: string) {
	return `"${value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("`", "\\`")}"`;
}

function shellPathQuote(value: string) {
	if (value.startsWith(SANDBOX_HOME)) {
		const suffix = value
			.slice(SANDBOX_HOME.length)
			.replaceAll("\\", "\\\\")
			.replaceAll('"', '\\"')
			.replaceAll("$", "\\$")
			.replaceAll("`", "\\`");
		return `"${SANDBOX_HOME}${suffix}"`;
	}
	return shellDoubleQuote(value);
}

function joinCommands(commands: Array<string | null | undefined>) {
	return commands.filter(Boolean).join("\n");
}

function binaryTargetDir(kind: "native" | "acp", agent: RegistryAgent) {
	const root = kind === "native" ? NATIVE_ROOT_DIR : ACP_ROOT_DIR;
	return `${root}/${agent.id}/${agent.version ?? "latest"}`;
}

function trimRelativeCommand(cmd: string) {
	return cmd.startsWith("./") ? cmd.slice(2) : cmd;
}

function tarExtractCommand(archiveUrl: string) {
	if (archiveUrl.endsWith(".zip")) {
		return 'unzip -q "$tmp_dir/archive" -d "$tmp_dir/unpack"';
	}
	if (archiveUrl.endsWith(".tar.bz2")) {
		return 'tar -xjf "$tmp_dir/archive" -C "$tmp_dir/unpack"';
	}
	if (archiveUrl.endsWith(".tar.gz") || archiveUrl.endsWith(".tgz")) {
		return 'tar -xzf "$tmp_dir/archive" -C "$tmp_dir/unpack"';
	}
	return 'tar -xf "$tmp_dir/archive" -C "$tmp_dir/unpack"';
}

function buildBinaryInstallCommand(params: {
	archive: string;
	commandPath: string;
	installDir: string;
	symlinkName?: string | null;
}) {
	const executablePath = trimRelativeCommand(params.commandPath);
	const symlinkCommand = params.symlinkName
		? `ln -sf "$install_dir/${executablePath}" "${USER_BIN_DIR}/${params.symlinkName}"`
		: null;
	return joinCommands([
		`mkdir -p "${USER_BIN_DIR}"`,
		'tmp_dir="$(mktemp -d)"',
		`install_dir=${shellPathQuote(params.installDir)}`,
		'cleanup() { rm -rf "$tmp_dir"; }',
		"trap cleanup EXIT",
		'rm -rf "$install_dir"',
		'mkdir -p "$install_dir" "$tmp_dir/unpack"',
		`curl -fsSL ${shellQuote(params.archive)} -o "$tmp_dir/archive"`,
		tarExtractCommand(params.archive),
		'cp -R "$tmp_dir/unpack"/. "$install_dir"/',
		`chmod +x "$install_dir/${executablePath}"`,
		symlinkCommand,
	]);
}

function buildBinaryDistributionInstall(
	agent: RegistryAgent,
	kind: "native" | "acp",
	overrides?: { executableName?: string | null; symlinkName?: string | null }
) {
	const platform = agent.distribution.binary?.[ACP_PLATFORM];
	if (!platform) {
		return { installCommand: null, runtimeCommand: null };
	}

	const installDir = binaryTargetDir(kind, agent);
	const executablePath = trimRelativeCommand(platform.cmd);
	const commandBaseName =
		overrides?.executableName ??
		executablePath.split("/").at(-1)?.replace(WINDOWS_SUFFIX_RE, "") ??
		null;
	const installCommand = buildBinaryInstallCommand({
		archive: platform.archive,
		commandPath: platform.cmd,
		installDir,
		symlinkName:
			kind === "native" ? (overrides?.symlinkName ?? commandBaseName) : null,
	});
	const runtimeCommand =
		kind === "native"
			? commandBaseName
				? {
						command: `${USER_BIN_DIR}/${commandBaseName}`,
						args: platform.args ?? [],
					}
				: null
			: {
					command: `${installDir}/${executablePath}`,
					args: platform.args ?? [],
				};
	return { installCommand, runtimeCommand };
}

function buildNpmInstallCommand(packageSpec: string, prefixDir: string) {
	return joinCommands([
		`mkdir -p "${prefixDir}" "${USER_BIN_DIR}"`,
		`npm install -g --prefix ${shellPathQuote(prefixDir)} ${shellQuote(packageSpec)}`,
	]);
}

function buildNpxDistributionInstall(
	agent: RegistryAgent,
	kind: "native" | "acp",
	overrides?: { executableName?: string | null }
) {
	const npx = agent.distribution.npx;
	if (!npx) {
		return { installCommand: null, runtimeCommand: null };
	}

	const { name } = packageSpecSchema(npx.package);
	const executableName = overrides?.executableName ?? inferExecutableName(name);
	if (kind === "native") {
		return {
			installCommand: buildNpmInstallCommand(
				npx.package,
				`${SANDBOX_HOME}/.local`
			),
			runtimeCommand: {
				command: `${USER_BIN_DIR}/${executableName}`,
				args: npx.args ?? [],
				...(npx.env ? { env: npx.env } : {}),
			},
		};
	}

	const prefixDir = `${ACP_ROOT_DIR}/npm/${agent.id}`;
	return {
		installCommand: buildNpmInstallCommand(npx.package, prefixDir),
		runtimeCommand: {
			command: `${prefixDir}/bin/${executableName}`,
			args: npx.args ?? [],
			...(npx.env ? { env: npx.env } : {}),
		},
	};
}

function buildUvxInstallCommand(packageSpec: string) {
	return joinCommands([
		`mkdir -p "${USER_BIN_DIR}"`,
		`uv tool install --force --bin-dir "${USER_BIN_DIR}" ${shellQuote(packageSpec)}`,
	]);
}

function buildUvxDistributionInstall(
	agent: RegistryAgent,
	kind: "native" | "acp",
	overrides?: { executableName?: string | null }
) {
	const uvx = agent.distribution.uvx;
	if (!uvx) {
		return { installCommand: null, runtimeCommand: null };
	}

	const { name } = packageSpecSchema(uvx.package);
	const executableName = overrides?.executableName ?? inferExecutableName(name);
	return {
		installCommand: buildUvxInstallCommand(uvx.package),
		runtimeCommand: {
			command: kind === "native" ? `${USER_BIN_DIR}/${executableName}` : "uvx",
			args:
				kind === "native"
					? (uvx.args ?? [])
					: [uvx.package, ...(uvx.args ?? [])],
		},
	};
}

function buildDistributionInstall(
	agent: RegistryAgent,
	kind: "native" | "acp",
	overrides?: { executableName?: string | null; symlinkName?: string | null }
): {
	installCommand: string | null;
	runtimeCommand: GeneratedRuntimeCommand | null;
} {
	if (agent.distribution.binary) {
		return buildBinaryDistributionInstall(agent, kind, overrides);
	}
	if (agent.distribution.npx) {
		return buildNpxDistributionInstall(agent, kind, overrides);
	}
	if (agent.distribution.uvx) {
		return buildUvxDistributionInstall(agent, kind, overrides);
	}
	return { installCommand: null, runtimeCommand: null };
}

function buildInstallCommand(agent: {
	id: string;
	name: string;
	nativeInstallCommand: string | null;
	acpInstallCommand: string | null;
}) {
	if (!(agent.nativeInstallCommand || agent.acpInstallCommand)) {
		return null;
	}

	const commands = [
		`export PATH="${USER_BIN_DIR}:$PATH"`,
		agent.nativeInstallCommand,
		agent.acpInstallCommand
			? `(${agent.acpInstallCommand}) >/tmp/corporation-acp-${agent.id}.log 2>&1 &`
			: null,
		agent.acpInstallCommand
			? `printf "Preparing ${agent.name} ACP runtime in the background. Logs: /tmp/corporation-acp-${agent.id}.log\\n"`
			: null,
	];

	return joinCommands(commands);
}

function getNativeInstallAndRuntime(manual: SupportedAcpAgentConfig) {
	if (manual.nativeInstallCommand || manual.runtimeCommandOverride) {
		const runtimeCommand = manual.runtimeCommandOverride ?? null;
		return {
			nativeInstallCommand: manual.nativeInstallCommand ?? null,
			nativeRuntimeCommand: runtimeCommand,
		};
	}

	return {
		nativeInstallCommand: null,
		nativeRuntimeCommand: null,
	};
}

function toGeneratedAgent(
	agent: RegistryAgent,
	config: SupportedAcpAgentConfig
): GeneratedAgent {
	const fallbackNative = buildDistributionInstall(agent, "native");
	const fallbackAcp = buildDistributionInstall(agent, "acp", {
		executableName: config.acpExecutableName ?? undefined,
	});
	const manualNative = getNativeInstallAndRuntime(config);

	const nativeInstallCommand =
		manualNative.nativeInstallCommand ?? fallbackNative.installCommand;
	const nativeRuntimeCommand =
		manualNative.nativeRuntimeCommand ?? fallbackNative.runtimeCommand;

	const useNativeForRuntime = config.acpInstallStrategy === "native";
	const acpInstallCommand = useNativeForRuntime
		? null
		: fallbackAcp.installCommand;
	const runtimeCommand =
		config.runtimeCommandOverride ??
		(useNativeForRuntime ? nativeRuntimeCommand : fallbackAcp.runtimeCommand);
	const installCommand = buildInstallCommand({
		id: agent.id,
		name: agent.name,
		nativeInstallCommand,
		acpInstallCommand,
	});

	if (!runtimeCommand) {
		throw new Error(`Supported agent ${agent.id} is missing a runtime command`);
	}
	if (!installCommand) {
		throw new Error(
			`Supported agent ${agent.id} is missing an install command`
		);
	}

	return {
		...agent,
		icon: agent.icon ?? null,
		nativeInstallCommand,
		acpInstallCommand,
		runtimeCommand,
		installCommand,
		installSource: config.installSource,
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
