import { createLogger } from "@corporation/logger";
import { type Daytona, Image, type Sandbox } from "@daytonaio/sdk";

const PORT = 3000;
const SNAPSHOT_NAME = "sandbox-agent-ready";
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;

const log = createLogger("sandbox-lifecycle");

export async function ensureSnapshot(daytona: Daytona): Promise<void> {
	let exists = true;
	try {
		await daytona.snapshot.get(SNAPSHOT_NAME);
	} catch {
		exists = false;
	}

	if (!exists) {
		log.info("creating snapshot, this may take a while");
		await daytona.snapshot.create({
			name: SNAPSHOT_NAME,
			image: Image.base("ubuntu:22.04").runCommands(
				"apt-get update && apt-get install -y curl ca-certificates git",
				"curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
				"sandbox-agent install-agent claude"
			),
		});
		log.info("snapshot created");
	}
}

export async function createReadySandbox(
	daytona: Daytona,
	anthropicApiKey: string
): Promise<Sandbox> {
	await ensureSnapshot(daytona);
	const sandbox = await daytona.create({
		snapshot: SNAPSHOT_NAME,
		envVars: { ANTHROPIC_API_KEY: anthropicApiKey },
		autoStopInterval: 0,
	});
	log.debug({ sandboxId: sandbox.id }, "sandbox created");
	await bootSandboxAgent(sandbox);
	return sandbox;
}

export async function bootSandboxAgent(sandbox: Sandbox): Promise<void> {
	await sandbox.process.executeCommand(
		`nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT} >/tmp/sandbox-agent.log 2>&1 &`
	);
	await waitForServerReady(sandbox);
	log.debug({ sandboxId: sandbox.id }, "sandbox-agent server ready");
}

async function waitForServerReady(sandbox: Sandbox): Promise<void> {
	const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;

	while (Date.now() < deadline) {
		try {
			const result = await sandbox.process.executeCommand(
				`curl -sf http://localhost:${PORT}/v1/health`
			);
			if (result.exitCode === 0) {
				return;
			}
		} catch {
			// Server not ready yet
		}
		await new Promise((resolve) =>
			setTimeout(resolve, SERVER_POLL_INTERVAL_MS)
		);
	}

	throw new Error("sandbox-agent server failed to start within timeout");
}

async function isSandboxAgentHealthy(sandbox: Sandbox): Promise<boolean> {
	try {
		const result = await sandbox.process.executeCommand(
			`curl -sf --max-time 1 http://localhost:${PORT}/v1/health`
		);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

export async function ensureSandboxAgentRunning(
	sandbox: Sandbox
): Promise<void> {
	const healthy = await isSandboxAgentHealthy(sandbox);
	if (healthy) {
		return;
	}

	log.warn(
		{ sandboxId: sandbox.id },
		"sandbox-agent health check failed, restarting server"
	);
	await bootSandboxAgent(sandbox);
}

const PREVIEW_URL_EXPIRY_SECONDS = 86_400; // 24 hours

export async function getPreviewUrl(sandbox: Sandbox): Promise<string> {
	const result = await sandbox.getSignedPreviewUrl(
		PORT,
		PREVIEW_URL_EXPIRY_SECONDS
	);
	return result.url;
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

const REPO_DIR = "project";
const GIT_USERNAME = "x-access-token";

export type RepoInfo = {
	owner: string;
	name: string;
	branchName: string;
};

export async function cloneRepoIntoSandbox(
	sandbox: Sandbox,
	githubToken: string,
	repo: RepoInfo
): Promise<void> {
	const cloneUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
	log.info(
		{ sandboxId: sandbox.id, repo: `${repo.owner}/${repo.name}` },
		"cloning repository into sandbox"
	);
	await sandbox.git.clone(
		cloneUrl,
		REPO_DIR,
		repo.branchName,
		undefined,
		GIT_USERNAME,
		githubToken
	);
	log.info({ sandboxId: sandbox.id }, "repository cloned");
}

export async function pullRepoInSandbox(
	sandbox: Sandbox,
	githubToken: string
): Promise<void> {
	log.info({ sandboxId: sandbox.id }, "pulling latest changes");
	await sandbox.git.pull(REPO_DIR, GIT_USERNAME, githubToken);
	log.info({ sandboxId: sandbox.id }, "pull complete");
}
