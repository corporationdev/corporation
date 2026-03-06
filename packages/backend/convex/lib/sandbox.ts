"use node";

import type { Sandbox } from "e2b";
import { normalizeBranchName, quoteShellArg } from "./git";

export const SANDBOX_AGENT_PORT = 5799;
export const CODE_SERVER_PORT = 8080;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;

export const REPO_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
const NEEDS_QUOTING_RE = /[\s"'#]/;
const LOCALHOST_PORT_RE = /http:\/\/localhost:(\d+)/g;
const TRAILING_SLASH_RE = /\/$/;
const COMMAND_OUTPUT_MAX_LENGTH = 2000;
export const DEV_SERVER_SESSION_NAME = "devserver";
export const SANDBOX_AGENT_SESSION_NAME = "sandbox-agent";
export const CODE_SERVER_SESSION_NAME = "code-server";

const AI_API_KEY_NAMES = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"OPENCODE_API_KEY",
] as const;

export function getAiEnvs(): Record<string, string> {
	const envs: Record<string, string> = {};
	for (const key of AI_API_KEY_NAMES) {
		const value = process.env[key];
		if (value) {
			envs[key] = value;
		}
	}
	if (Object.keys(envs).length === 0) {
		throw new Error(
			`Missing AI API key env vars (need at least one of: ${AI_API_KEY_NAMES.join(", ")})`
		);
	}
	return envs;
}

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
	setupCommand: string;
	updateCommand: string;
	devCommand: string;
	devPort: number;
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

/**
 * Pushes the current branch to the remote. Stages and commits any
 * uncommitted changes first (as the given author). Returns whether
 * there were any commits to push (i.e. the branch diverged from
 * the default branch).
 */
export async function pushBranch(
	sandbox: Sandbox,
	env: SandboxEnv,
	githubToken: string,
	branchName: string,
	author: { name: string; email: string }
): Promise<boolean> {
	const { repository } = env;
	const workdir = getSandboxWorkdir(repository);
	const repoUrl = `https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git`;
	const safeBranchName = quoteShellArg(normalizeBranchName(branchName));
	const safeRepoUrl = quoteShellArg(repoUrl);
	const safeAuthorName = quoteShellArg(author.name);
	const safeAuthorEmail = quoteShellArg(author.email);
	const safeCompareRange = quoteShellArg(`${repository.defaultBranch}..HEAD`);

	await runRootCommand(sandbox, `git remote set-url origin ${safeRepoUrl}`, {
		cwd: workdir,
	});

	await runRootCommand(sandbox, "git add -A", {
		cwd: workdir,
	});

	await runRootCommand(
		sandbox,
		`git diff --cached --quiet || git -c user.name=${safeAuthorName} -c user.email=${safeAuthorEmail} commit -m 'Update from Corporation'`,
		{ cwd: workdir }
	);

	const diffResult = await runRootCommand(
		sandbox,
		`git log ${safeCompareRange} --oneline`,
		{ cwd: workdir }
	);
	const hasCommits = diffResult.stdout.trim().length > 0;

	if (!hasCommits) {
		return false;
	}

	await runRootCommand(sandbox, `git push origin ${safeBranchName}`, {
		cwd: workdir,
		timeoutMs: REPO_SYNC_TIMEOUT_MS,
	});

	return true;
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
