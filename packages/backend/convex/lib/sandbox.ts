import type { Sandbox } from "e2b";
import { normalizeBranchName, quoteShellArg } from "./git";

const REPO_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
const NEEDS_QUOTING_RE = /[\s"'#]/;
const LOCALHOST_PORT_RE = /http:\/\/localhost:(\d+)/g;
const TRAILING_SLASH_RE = /\/$/;

type EnvVar = { key: string; value: string };

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
	mode: "clone" | "pull"
): Promise<string | undefined> {
	const { repository } = env;
	const workdir = `/root/${repository.owner}-${repository.name}`;
	const repoUrl = `https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git`;
	const safeRepoUrl = quoteShellArg(repoUrl);
	const safeWorkdir = quoteShellArg(workdir);
	const safeDefaultBranch = quoteShellArg(repository.defaultBranch);

	if (mode === "clone") {
		await sandbox.commands.run(
			`git clone ${safeRepoUrl} ${safeWorkdir} --branch ${safeDefaultBranch} --single-branch`,
			{ user: "root", timeoutMs: REPO_SYNC_TIMEOUT_MS }
		);
	} else {
		await sandbox.commands.run(
			`git remote set-url origin ${safeRepoUrl} && git pull origin ${safeDefaultBranch}`,
			{ cwd: workdir, user: "root", timeoutMs: REPO_SYNC_TIMEOUT_MS }
		);
	}

	await writeEnvFiles(sandbox, env, workdir);

	await sandbox.commands.run(env.setupCommand, {
		cwd: workdir,
		user: "root",
		timeoutMs: REPO_SYNC_TIMEOUT_MS,
	});

	const shaResult = await sandbox.commands.run("git rev-parse HEAD", {
		cwd: workdir,
		user: "root",
	});
	return shaResult.stdout.trim() || undefined;
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

	await sandbox.commands.run(`git remote set-url origin ${safeRepoUrl}`, {
		cwd: workdir,
		user: "root",
	});

	await sandbox.commands.run("git add -A", {
		cwd: workdir,
		user: "root",
	});

	await sandbox.commands.run(
		`git diff --cached --quiet || git -c user.name=${safeAuthorName} -c user.email=${safeAuthorEmail} commit -m 'Update from Corporation'`,
		{ cwd: workdir, user: "root" }
	);

	const diffResult = await sandbox.commands.run(
		`git log ${safeCompareRange} --oneline`,
		{ cwd: workdir, user: "root" }
	);
	const hasCommits = diffResult.stdout.trim().length > 0;

	if (!hasCommits) {
		return false;
	}

	await sandbox.commands.run(`git push origin ${safeBranchName}`, {
		cwd: workdir,
		user: "root",
		timeoutMs: REPO_SYNC_TIMEOUT_MS,
	});

	return true;
}
