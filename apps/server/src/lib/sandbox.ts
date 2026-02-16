import { createLogger } from "@corporation/logger";
import type { Sandbox } from "@daytonaio/sdk";

const PORT = 3000;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const PREVIEW_URL_EXPIRY_SECONDS = 86_400; // 24 hours

const log = createLogger("sandbox");

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

export async function getPreviewUrl(sandbox: Sandbox): Promise<string> {
	const result = await sandbox.getSignedPreviewUrl(
		PORT,
		PREVIEW_URL_EXPIRY_SECONDS
	);
	return result.url;
}
