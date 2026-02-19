import { createLogger } from "@corporation/logger";
import type { Sandbox } from "@daytonaio/sdk";

const SANDBOX_AGENT_PORT = 5799;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const PREVIEW_URL_EXPIRY_SECONDS = 86_400; // 24 hours

const log = createLogger("sandbox");

const NEEDS_QUOTING_RE = /[\s"'#]/;

export async function bootSandboxAgent(sandbox: Sandbox): Promise<void> {
	await sandbox.process.executeCommand(
		`nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${SANDBOX_AGENT_PORT} >/tmp/sandbox-agent.log 2>&1 &`
	);
	await waitForServerReady(sandbox);
	log.debug({ sandboxId: sandbox.id }, "sandbox-agent server ready");
}

async function waitForServerReady(sandbox: Sandbox): Promise<void> {
	const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;

	while (Date.now() < deadline) {
		try {
			const result = await sandbox.process.executeCommand(
				`curl -sf http://localhost:${SANDBOX_AGENT_PORT}/v1/health`
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
			`curl -sf --max-time 1 http://localhost:${SANDBOX_AGENT_PORT}/v1/health`
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

export async function getPreviewUrl(sandbox: Sandbox): Promise<string> {
	const result = await sandbox.getSignedPreviewUrl(
		SANDBOX_AGENT_PORT,
		PREVIEW_URL_EXPIRY_SECONDS
	);
	return result.url;
}

export async function writeServiceEnvFiles(
	sandbox: Sandbox,
	services: Array<{
		cwd: string;
		envVars?: Array<{ key: string; value: string }>;
	}>
): Promise<void> {
	const files = services
		.filter(
			(s): s is typeof s & { envVars: Array<{ key: string; value: string }> } =>
				s.envVars !== undefined && s.envVars.length > 0
		)
		.map((s) => {
			const content = s.envVars
				.map(({ key, value }) => {
					if (NEEDS_QUOTING_RE.test(value)) {
						return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
					}
					return `${key}=${value}`;
				})
				.join("\n");
			const dir = s.cwd || ".";
			return { source: Buffer.from(content), destination: `${dir}/.env` };
		});

	if (files.length === 0) {
		return;
	}

	await sandbox.fs.uploadFiles(files);
	log.debug({ sandboxId: sandbox.id, count: files.length }, "wrote .env files");
}
