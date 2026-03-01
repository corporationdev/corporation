import type { Sandbox } from "e2b";
import { normalizeBranchName, quoteShellArg } from "./git";

const REPO_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
const NEEDS_QUOTING_RE = /[\s"'#]/;
const LOCALHOST_PORT_RE = /http:\/\/localhost:(\d+)/g;
const TRAILING_SLASH_RE = /\/$/;
const COMMAND_OUTPUT_MAX_LENGTH = 2000;

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

export type SandboxEnv = {
	repository: {
		owner: string;
		name: string;
		defaultBranch: string;
	};
	setupCommand: string;
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
	const workdir = `/root/${repository.owner}-${repository.name}`;
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
	const workdir = `/root/${repository.owner}-${repository.name}`;
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
