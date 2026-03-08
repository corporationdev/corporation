"use node";

import type { Sandbox } from "e2b";
import { quoteShellArg } from "./git";

export const SANDBOX_AGENT_PORT = 5799;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;

export const REPO_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
const NEEDS_QUOTING_RE = /[\s"'#]/;
const LOCALHOST_PORT_RE = /http:\/\/localhost:(\d+)/g;
const TRAILING_SLASH_RE = /\/$/;
const COMMAND_OUTPUT_MAX_LENGTH = 2000;
export const DEV_SERVER_SESSION_NAME = "devserver";
export const SANDBOX_AGENT_SESSION_NAME = "sandbox-agent";

type EnvVar = { key: string; value: string };
type CommandExitErrorLike = {
	exitCode: number;
	stderr: string;
	stdout: string;
};
type RunRootCommandOptions = Omit<
	NonNullable<Parameters<Sandbox["commands"]["run"]>[1]>,
	"user"
>;

export function getSandboxWorkdir(repository: {
	owner: string;
	name: string;
}): string {
	return `/root/${repository.owner}-${repository.name}`;
}

export type SandboxEnv = {
	repository: {
		owner: string;
		name: string;
		defaultBranch: string;
	};
	envByPath?: Record<string, Record<string, string>> | null;
};

function getPreviewUrl(sandbox: Sandbox, port: number): string {
	return `https://${sandbox.getHost(port)}`;
}

function formatEnvContent(envVars: EnvVar[]): string {
	return envVars
		.map(({ key, value }) => {
			if (NEEDS_QUOTING_RE.test(value)) {
				return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
			}
			return `${key}=${value}`;
		})
		.join("\n");
}

function resolvePreviewUrls(sandbox: Sandbox, envVars: EnvVar[]): EnvVar[] {
	const ports = new Set<number>();
	for (const { value } of envVars) {
		for (const match of value.matchAll(LOCALHOST_PORT_RE)) {
			ports.add(Number.parseInt(match[1], 10));
		}
	}

	if (ports.size === 0) {
		return envVars;
	}

	const portToUrl = new Map<number, string>();
	for (const port of ports) {
		const url = getPreviewUrl(sandbox, port);
		portToUrl.set(port, url.replace(TRAILING_SLASH_RE, ""));
	}

	return envVars.map(({ key, value }) => ({
		key,
		value: value.replace(LOCALHOST_PORT_RE, (_match, portStr) => {
			const port = Number.parseInt(portStr, 10);
			return portToUrl.get(port) ?? _match;
		}),
	}));
}

function envMapToPairs(envMap: Record<string, string>): EnvVar[] {
	return Object.entries(envMap)
		.filter(([key]) => key.trim().length > 0)
		.map(([key, value]) => ({ key, value }));
}

function truncateOutput(
	output: string,
	maxLength = COMMAND_OUTPUT_MAX_LENGTH
): string {
	if (output.length <= maxLength) {
		return output;
	}
	return `${output.slice(0, maxLength)}...`;
}

function isCommandExitError(error: unknown): error is CommandExitErrorLike {
	if (!error || typeof error !== "object") {
		return false;
	}
	const candidate = error as Record<string, unknown>;
	return (
		typeof candidate.exitCode === "number" &&
		typeof candidate.stderr === "string" &&
		typeof candidate.stdout === "string"
	);
}

export async function runRootCommand(
	sandbox: Sandbox,
	command: string,
	options: RunRootCommandOptions = {}
) {
	try {
		return await sandbox.commands.run(command, {
			...options,
			user: "root",
		});
	} catch (error) {
		if (isCommandExitError(error)) {
			const cwdMessage = options.cwd ? ` (cwd: ${options.cwd})` : "";
			throw new Error(
				[
					`Sandbox command failed${cwdMessage}: ${command}`,
					`Exit code: ${error.exitCode}`,
					`stderr: ${truncateOutput(error.stderr)}`,
					`stdout: ${truncateOutput(error.stdout)}`,
				].join("\n")
			);
		}
		throw error;
	}
}

export async function writeEnvFiles(
	sandbox: Sandbox,
	env: SandboxEnv,
	workdir: string
): Promise<void> {
	const files: Array<{ path: string; data: string }> = [];
	const envByPath = env.envByPath ?? {};

	for (const [rawPath, envMap] of Object.entries(envByPath)) {
		const envVars = envMapToPairs(envMap);
		if (envVars.length === 0) {
			continue;
		}

		const resolved = resolvePreviewUrls(sandbox, envVars);
		const path = rawPath === "." ? workdir : `${workdir}/${rawPath}`;
		files.push({
			path: `${path}/.env`,
			data: formatEnvContent(resolved),
		});
	}

	if (files.length === 0) {
		return;
	}

	await sandbox.files.writeFiles(files);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export type BootServerOptions = {
	sessionName: string;
	command: string;
	healthUrl: string;
	workdir?: string;
	appendLog?: (chunk: string) => void;
};

export async function bootServer(
	sandbox: Sandbox,
	opts: BootServerOptions
): Promise<void> {
	const { sessionName, command, healthUrl, workdir, appendLog } = opts;

	appendLog?.(`Starting ${sessionName} (tmux session)...\n`);

	const cwdFlag = workdir ? `-c ${quoteShellArg(workdir)} ` : "";
	await runRootCommand(
		sandbox,
		`tmux new-session -d -s ${sessionName} ${cwdFlag}${quoteShellArg(command)} \\; set-option -t ${sessionName} mouse on \\; set-option -t ${sessionName} status off`
	);

	appendLog?.(`Waiting for ${sessionName} to be ready...\n`);

	const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run(`curl -sf --max-time 2 ${healthUrl}`);
			appendLog?.(`${sessionName} is ready.\n`);
			return;
		} catch (error) {
			if (!isCommandExitError(error)) {
				throw error;
			}
		}

		try {
			await sandbox.commands.run(`tmux has-session -t ${sessionName}`);
		} catch (error) {
			if (isCommandExitError(error)) {
				throw new Error(`${sessionName} process exited before becoming ready`);
			}
			throw error;
		}

		await sleep(SERVER_POLL_INTERVAL_MS);
	}

	throw new Error(
		`${sessionName} did not become ready within ${SERVER_STARTUP_TIMEOUT_MS / 1000}s`
	);
}

export async function killDevServer(sandbox: Sandbox): Promise<void> {
	try {
		await sandbox.commands.run(
			`tmux kill-session -t ${DEV_SERVER_SESSION_NAME}`
		);
	} catch (error) {
		if (isCommandExitError(error)) {
			return;
		}
		throw error;
	}
}

export async function hasDevServerSession(sandbox: Sandbox): Promise<boolean> {
	try {
		await sandbox.commands.run(
			`tmux has-session -t ${DEV_SERVER_SESSION_NAME}`
		);
		return true;
	} catch (error) {
		if (isCommandExitError(error)) {
			return false;
		}
		throw error;
	}
}
