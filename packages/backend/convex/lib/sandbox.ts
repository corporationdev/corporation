"use node";

import type { Sandbox } from "e2b";
import { normalizeBranchName, quoteShellArg } from "./git";

const REPO_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
const NEEDS_QUOTING_RE = /[\s"'#]/;
const LOCALHOST_PORT_RE = /http:\/\/localhost:(\d+)/g;
const TRAILING_SLASH_RE = /\/$/;
const COMMAND_OUTPUT_MAX_LENGTH = 2000;
const DEV_SERVER_SESSION_NAME = "devserver";
const DEV_SERVER_STARTUP_TIMEOUT_MS = 120_000;
const DEV_SERVER_POLL_INTERVAL_MS = 1000;
const CODE_SERVER_SESSION_NAME = "codeserver";
const CODE_SERVER_PORT = 8080;
const CODE_SERVER_STARTUP_TIMEOUT_MS = 60_000;

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

async function writeEnvFiles(
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
 * Sets up a sandbox with the repository: syncs git, writes env files,
 * runs setup command. Returns the HEAD commit SHA.
 *
 * - "clone": fresh git clone (for initial builds)
 * - "pull": git pull on existing repo (for rebuilds and syncs)
 */
export async function setupSandbox(
	sandbox: Sandbox,
	env: SandboxEnv,
	githubToken: string,
	mode: "clone" | "pull",
	appendLog?: (chunk: string) => void
): Promise<string> {
	const { repository } = env;
	const workdir = getSandboxWorkdir(repository);
	const repoUrl = `https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git`;
	const safeRepoUrl = quoteShellArg(repoUrl);
	const safeWorkdir = quoteShellArg(workdir);
	const safeDefaultBranch = quoteShellArg(repository.defaultBranch);

	if (mode === "clone") {
		await runRootCommand(
			sandbox,
			`git clone ${safeRepoUrl} ${safeWorkdir} --branch ${safeDefaultBranch} --single-branch`,
			{
				timeoutMs: REPO_SYNC_TIMEOUT_MS,
				onStdout: appendLog,
				onStderr: appendLog,
			}
		);
	} else {
		await runRootCommand(
			sandbox,
			`git remote set-url origin ${safeRepoUrl} && git pull origin ${safeDefaultBranch}`,
			{
				cwd: workdir,
				timeoutMs: REPO_SYNC_TIMEOUT_MS,
				onStdout: appendLog,
				onStderr: appendLog,
			}
		);
	}

	await writeEnvFiles(sandbox, env, workdir);
	appendLog?.("Environment files written.\n");

	await runRootCommand(sandbox, env.setupCommand, {
		cwd: workdir,
		timeoutMs: REPO_SYNC_TIMEOUT_MS,
		onStdout: appendLog,
		onStderr: appendLog,
	});

	const shaResult = await runRootCommand(sandbox, "git rev-parse HEAD", {
		cwd: workdir,
	});
	return shaResult.stdout.trim();
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

export async function startDevServer(
	sandbox: Sandbox,
	env: SandboxEnv,
	appendLog?: (chunk: string) => void
): Promise<void> {
	const { repository } = env;
	const workdir = getSandboxWorkdir(repository);
	const safeCommand = quoteShellArg(env.devCommand);

	appendLog?.(
		`Starting dev server (tmux session: ${DEV_SERVER_SESSION_NAME})...\n`
	);

	await runRootCommand(
		sandbox,
		`tmux new-session -d -s ${DEV_SERVER_SESSION_NAME} -c ${quoteShellArg(workdir)} ${safeCommand} \\; set-option -t ${DEV_SERVER_SESSION_NAME} mouse on \\; set-option -t ${DEV_SERVER_SESSION_NAME} status off`
	);

	appendLog?.(`Waiting for dev server on port ${env.devPort}...\n`);

	const deadline = Date.now() + DEV_SERVER_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run(
				`curl -sf --max-time 2 http://localhost:${env.devPort}/`
			);
			appendLog?.(`Dev server is ready on port ${env.devPort}.\n`);
			return;
		} catch (error) {
			if (!isCommandExitError(error)) {
				throw error;
			}
		}

		// Check that the tmux session is still alive
		try {
			await sandbox.commands.run(
				`tmux has-session -t ${DEV_SERVER_SESSION_NAME}`
			);
		} catch (error) {
			if (isCommandExitError(error)) {
				throw new Error("Dev server process exited before becoming ready");
			}
			throw error;
		}

		await sleep(DEV_SERVER_POLL_INTERVAL_MS);
	}

	throw new Error(
		`Dev server did not become ready on port ${env.devPort} within ${DEV_SERVER_STARTUP_TIMEOUT_MS / 1000}s`
	);
}

export async function killDevServer(sandbox: Sandbox): Promise<void> {
	try {
		await sandbox.commands.run(
			`tmux kill-session -t ${DEV_SERVER_SESSION_NAME}`
		);
	} catch (error) {
		if (isCommandExitError(error)) {
			return; // Session doesn't exist
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

/**
 * Checks if code-server is installed in the sandbox.
 */
async function isCodeServerInstalled(sandbox: Sandbox): Promise<boolean> {
	try {
		await sandbox.commands.run("which code-server");
		return true;
	} catch (error) {
		if (isCommandExitError(error)) {
			return false;
		}
		throw error;
	}
}

/**
 * Installs code-server in the sandbox using the official install script.
 */
async function installCodeServer(
	sandbox: Sandbox,
	appendLog?: (chunk: string) => void
): Promise<void> {
	appendLog?.("Installing code-server...\n");

	await runRootCommand(
		sandbox,
		"curl -fsSL https://code-server.dev/install.sh | sh",
		{
			timeoutMs: 120_000,
			onStdout: appendLog,
			onStderr: appendLog,
		}
	);

	appendLog?.("code-server installed successfully.\n");
}

/**
 * Starts code-server in a tmux session. Installs it first if not already installed.
 * Returns the URL to access code-server.
 */
export async function startCodeServer(
	sandbox: Sandbox,
	env: SandboxEnv,
	appendLog?: (chunk: string) => void
): Promise<string> {
	const { repository } = env;
	const workdir = getSandboxWorkdir(repository);

	// Check if already running
	try {
		await sandbox.commands.run(
			`tmux has-session -t ${CODE_SERVER_SESSION_NAME}`
		);
		appendLog?.("code-server is already running.\n");
		return getPreviewUrl(sandbox, CODE_SERVER_PORT);
	} catch (error) {
		if (!isCommandExitError(error)) {
			throw error;
		}
		// Session doesn't exist, continue with startup
	}

	// Install if needed
	const installed = await isCodeServerInstalled(sandbox);
	if (!installed) {
		await installCodeServer(sandbox, appendLog);
	}

	appendLog?.(
		`Starting code-server (tmux session: ${CODE_SERVER_SESSION_NAME})...\n`
	);

	// Start code-server in tmux with proper configuration
	await runRootCommand(
		sandbox,
		`tmux new-session -d -s ${CODE_SERVER_SESSION_NAME} -c ${quoteShellArg(workdir)} code-server --bind-addr 0.0.0.0:${CODE_SERVER_PORT} --auth none ${quoteShellArg(workdir)} \\; set-option -t ${CODE_SERVER_SESSION_NAME} mouse on \\; set-option -t ${CODE_SERVER_SESSION_NAME} status off`
	);

	appendLog?.(`Waiting for code-server on port ${CODE_SERVER_PORT}...\n`);

	// Wait for code-server to be ready
	const deadline = Date.now() + CODE_SERVER_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run(
				`curl -sf --max-time 2 http://localhost:${CODE_SERVER_PORT}/`
			);
			const url = getPreviewUrl(sandbox, CODE_SERVER_PORT);
			appendLog?.(`code-server is ready at ${url}\n`);
			return url;
		} catch (error) {
			if (!isCommandExitError(error)) {
				throw error;
			}
		}

		// Check that the tmux session is still alive
		try {
			await sandbox.commands.run(
				`tmux has-session -t ${CODE_SERVER_SESSION_NAME}`
			);
		} catch (error) {
			if (isCommandExitError(error)) {
				throw new Error("code-server process exited before becoming ready");
			}
			throw error;
		}

		await sleep(DEV_SERVER_POLL_INTERVAL_MS);
	}

	throw new Error(
		`code-server did not become ready on port ${CODE_SERVER_PORT} within ${CODE_SERVER_STARTUP_TIMEOUT_MS / 1000}s`
	);
}

/**
 * Kills the code-server tmux session if it exists.
 */
export async function killCodeServer(sandbox: Sandbox): Promise<void> {
	try {
		await sandbox.commands.run(
			`tmux kill-session -t ${CODE_SERVER_SESSION_NAME}`
		);
	} catch (error) {
		if (isCommandExitError(error)) {
			return; // Session doesn't exist
		}
		throw error;
	}
}

/**
 * Checks if the code-server tmux session is running.
 */
export async function hasCodeServerSession(sandbox: Sandbox): Promise<boolean> {
	try {
		await sandbox.commands.run(
			`tmux has-session -t ${CODE_SERVER_SESSION_NAME}`
		);
		return true;
	} catch (error) {
		if (isCommandExitError(error)) {
			return false;
		}
		throw error;
	}
}

export { DEV_SERVER_SESSION_NAME, CODE_SERVER_SESSION_NAME, CODE_SERVER_PORT };
