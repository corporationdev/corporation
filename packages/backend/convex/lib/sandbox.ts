import type { Sandbox } from "e2b";

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
		setupCommand: string;
		envVars?: EnvVar[] | null;
	};
	services: Array<{
		path: string;
		envVars?: EnvVar[] | null;
	}>;
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

async function writeEnvFiles(
	sandbox: Sandbox,
	env: SandboxEnv,
	workdir: string
): Promise<void> {
	const files: Array<{ path: string; data: string }> = [];

	const repoEnvVars = env.repository.envVars;
	if (repoEnvVars && repoEnvVars.length > 0) {
		const resolved = resolvePreviewUrls(sandbox, repoEnvVars);
		files.push({
			path: `${workdir}/.env`,
			data: formatEnvContent(resolved),
		});
	}

	for (const service of env.services) {
		if (service.envVars && service.envVars.length > 0) {
			const resolved = resolvePreviewUrls(sandbox, service.envVars);
			const dir = service.path || ".";
			files.push({
				path: `${workdir}/${dir}/.env`,
				data: formatEnvContent(resolved),
			});
		}
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

	if (mode === "clone") {
		await sandbox.commands.run(
			`git clone ${repoUrl} ${workdir} --branch ${repository.defaultBranch} --single-branch`,
			{ user: "root", timeoutMs: REPO_SYNC_TIMEOUT_MS }
		);
	} else {
		await sandbox.commands.run(
			`git remote set-url origin ${repoUrl} && git pull origin ${repository.defaultBranch}`,
			{ cwd: workdir, user: "root", timeoutMs: REPO_SYNC_TIMEOUT_MS }
		);
	}

	await writeEnvFiles(sandbox, env, workdir);

	await sandbox.commands.run(repository.setupCommand, {
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
