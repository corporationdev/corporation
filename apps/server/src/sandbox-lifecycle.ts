import { createLogger } from "@corporation/logger";
import { type Daytona, Image, type Sandbox } from "@daytonaio/sdk";

const PORT = 3000;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;

const log = createLogger("sandbox-lifecycle");

export async function createReadySandbox(
	daytona: Daytona,
	anthropicApiKey: string,
	snapshot: string
): Promise<Sandbox> {
	const sandbox = await daytona.create({
		snapshot,
		envVars: { ANTHROPIC_API_KEY: anthropicApiKey },
		autoStopInterval: 0,
	});
	log.debug({ sandboxId: sandbox.id, snapshot }, "sandbox created");
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
// Per-repo snapshots
// ---------------------------------------------------------------------------

export function repoSnapshotName(owner: string, name: string): string {
	return `repo-${owner}-${name}`;
}

export async function buildRepoSnapshot(
	daytona: Daytona,
	owner: string,
	name: string,
	branch: string,
	githubToken: string,
	installCommand: string
): Promise<string> {
	const snapshotName = repoSnapshotName(owner, name);

	try {
		const existing = await daytona.snapshot.get(snapshotName);
		await daytona.snapshot.delete(existing);
		log.info({ snapshotName }, "deleted existing repo snapshot");
	} catch {
		// Snapshot doesn't exist yet
	}

	log.info(
		{ snapshotName, repo: `${owner}/${name}` },
		"building repo snapshot"
	);
	await daytona.snapshot.create({
		name: snapshotName,
		image: Image.base("ubuntu:22.04").runCommands(
			"apt-get update && apt-get install -y curl ca-certificates git",
			"curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
			"sandbox-agent install-agent claude",
			`git clone https://x-access-token:${githubToken}@github.com/${owner}/${name}.git /home/daytona/project --branch ${branch} --single-branch`,
			`cd /home/daytona/project && ${installCommand}`
		),
	});
	log.info({ snapshotName }, "repo snapshot built");

	return snapshotName;
}
