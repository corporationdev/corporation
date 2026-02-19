import { createLogger } from "@corporation/logger";
import type { Sandbox } from "@daytonaio/sdk";

const SANDBOX_AGENT_PORT = 5799;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const PREVIEW_URL_EXPIRY_SECONDS = 86_400; // 24 hours
const DESKTOP_NOVNC_PORT = 6080;
const COMPUTER_USE_DEPENDENCIES_MARKER = "/var/tmp/.computer-use-deps-v1";
const COMPUTER_USE_SETUP_TIMEOUT_SECONDS = 1200;
const COMPUTER_USE_MARKER_CHECK_TIMEOUT_SECONDS = 10;
const COMPUTER_USE_API_TIMEOUT_MS = 30_000;
const COMPUTER_USE_RETRY_DELAY_MS = 2000;
const COMPUTER_USE_START_ATTEMPTS = 2;
const COMPUTER_USE_PROCESSES = ["xvfb", "xfce4", "x11vnc", "novnc"] as const;
const MANUAL_DESKTOP_BOOT_TIMEOUT_SECONDS = 90;
const MANUAL_DESKTOP_HEALTH_TIMEOUT_SECONDS = 40;

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

export async function getDesktopPreviewUrl(sandbox: Sandbox): Promise<string> {
	const result = await sandbox.getSignedPreviewUrl(
		DESKTOP_NOVNC_PORT,
		PREVIEW_URL_EXPIRY_SECONDS
	);
	return result.url;
}

function truncate(text: string | undefined, max = 400): string {
	if (!text) {
		return "";
	}

	const normalized = text.trim().replace(/\s+/g, " ");
	if (normalized.length <= max) {
		return normalized;
	}

	return `${normalized.slice(0, max)}...`;
}

function getErrorLogDetails(error: unknown): {
	message: string;
	code?: string;
	status?: number;
	responseData?: string;
	stack?: string;
} {
	if (!(error instanceof Error)) {
		return { message: String(error) };
	}

	const maybeAxios = error as Error & {
		code?: string;
		response?: { status?: number; data?: unknown };
	};

	let responseData: string | undefined;
	if (maybeAxios.response?.data !== undefined) {
		try {
			responseData = truncate(
				typeof maybeAxios.response.data === "string"
					? maybeAxios.response.data
					: JSON.stringify(maybeAxios.response.data)
			);
		} catch {
			responseData = "unserializable response data";
		}
	}

	return {
		message: error.message,
		code: maybeAxios.code,
		status: maybeAxios.response?.status,
		responseData,
		stack: error.stack,
	};
}

async function withTimeout<T>(
	operation: string,
	task: Promise<T>,
	timeoutMs = COMPUTER_USE_API_TIMEOUT_MS
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					reject(
						new Error(`${operation} timed out after ${timeoutMs.toString()}ms`)
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function isServiceUnavailableError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const maybeHttpError = error as Error & { statusCode?: number };
	if (maybeHttpError.statusCode === 503) {
		return true;
	}

	const message = error.message.toLowerCase();
	return (
		message.includes("status code 503") ||
		message.includes("computer-use functionality is not available")
	);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureManualDesktopRunning(sandbox: Sandbox): Promise<void> {
	log.warn(
		{ sandboxId: sandbox.id, novncPort: DESKTOP_NOVNC_PORT },
		"falling back to manual desktop/noVNC bootstrap"
	);

	const bootstrapScript = [
		"set -euo pipefail",
		"export DISPLAY=:1",
		"if ! pgrep -x Xvfb >/dev/null 2>&1; then nohup Xvfb :1 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 & fi",
		'if ! pgrep -f "xfce4-session" >/dev/null 2>&1; then nohup dbus-launch --exit-with-session xfce4-session >/tmp/xfce4.log 2>&1 & fi',
		"if ! pgrep -x x11vnc >/dev/null 2>&1; then nohup x11vnc -display :1 -forever -shared -nopw -rfbport 5900 >/tmp/x11vnc.log 2>&1 & fi",
		'NOVNC_PROXY_BIN=""',
		'if command -v novnc_proxy >/dev/null 2>&1; then NOVNC_PROXY_BIN="$(command -v novnc_proxy)"; elif [ -x /usr/share/novnc/utils/novnc_proxy ]; then NOVNC_PROXY_BIN="/usr/share/novnc/utils/novnc_proxy"; fi',
		'WEBSOCKIFY_BIN=""',
		'if command -v websockify >/dev/null 2>&1; then WEBSOCKIFY_BIN="$(command -v websockify)"; elif [ -x /usr/share/novnc/utils/websockify/run ]; then WEBSOCKIFY_BIN="/usr/share/novnc/utils/websockify/run"; fi',
		'NOVNC_WEB_ROOT=""',
		'for candidate in /usr/share/novnc /usr/share/novnc/www /usr/share/novnc/utils/../..; do if [ -f "$candidate/vnc.html" ]; then NOVNC_WEB_ROOT="$candidate"; break; fi; done',
		'if [ -n "$NOVNC_PROXY_BIN" ]; then if ! pgrep -f "novnc_proxy.*6080" >/dev/null 2>&1 && ! pgrep -f "websockify.*6080" >/dev/null 2>&1; then nohup "$NOVNC_PROXY_BIN" --vnc localhost:5900 --listen 6080 >/tmp/novnc.log 2>&1 & fi; elif [ -n "$WEBSOCKIFY_BIN" ] && [ -n "$NOVNC_WEB_ROOT" ]; then if ! pgrep -f "websockify.*6080" >/dev/null 2>&1; then nohup "$WEBSOCKIFY_BIN" --web="$NOVNC_WEB_ROOT" 6080 localhost:5900 >/tmp/novnc.log 2>&1 & fi; else echo "Unable to find noVNC launcher (novnc_proxy/websockify) or web root." >/tmp/novnc.log; exit 1; fi',
		"sleep 2",
	].join("\n");

	const escapedBootstrapScript = bootstrapScript.replaceAll("'", "'\\''");
	const bootstrapResult = await sandbox.process.executeCommand(
		`bash -lc '${escapedBootstrapScript}'`,
		undefined,
		undefined,
		MANUAL_DESKTOP_BOOT_TIMEOUT_SECONDS
	);
	if (bootstrapResult.exitCode !== 0) {
		const output = truncate(bootstrapResult.result, 1200);
		throw new Error(
			`Manual desktop bootstrap failed (exit ${bootstrapResult.exitCode}): ${output || "No output"}`
		);
	}

	const healthResult = await sandbox.process.executeCommand(
		`bash -lc 'for i in $(seq 1 30); do if curl -sfL --max-time 2 http://127.0.0.1:${DESKTOP_NOVNC_PORT}/vnc.html >/dev/null; then exit 0; fi; sleep 1; done; exit 1'`,
		undefined,
		undefined,
		MANUAL_DESKTOP_HEALTH_TIMEOUT_SECONDS
	);

	if (healthResult.exitCode !== 0) {
		const logsResult = await sandbox.process.executeCommand(
			`bash -lc 'echo "===== process snapshot ====="; ps -ef | grep -E "Xvfb|xfce4-session|x11vnc|novnc|websockify" | grep -v grep || true; echo "===== listening ports ====="; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":5900|:${DESKTOP_NOVNC_PORT}" || true; for f in /tmp/xvfb.log /tmp/xfce4.log /tmp/x11vnc.log /tmp/novnc.log; do if [ -f "$f" ]; then echo "===== $f ====="; tail -n 60 "$f"; else echo "===== $f (missing) ====="; fi; done'`,
			undefined,
			undefined,
			MANUAL_DESKTOP_HEALTH_TIMEOUT_SECONDS
		);
		const logs = truncate(logsResult.result, 2000);
		throw new Error(
			`Manual desktop health check failed on port ${DESKTOP_NOVNC_PORT}. Logs: ${logs || "No process logs available"}`
		);
	}

	log.info(
		{ sandboxId: sandbox.id, novncPort: DESKTOP_NOVNC_PORT },
		"manual desktop/noVNC bootstrap ready"
	);
}

export async function ensureComputerUseDependencies(
	sandbox: Sandbox
): Promise<void> {
	const startedAt = Date.now();
	log.info(
		{
			sandboxId: sandbox.id,
			marker: COMPUTER_USE_DEPENDENCIES_MARKER,
			timeoutSeconds: COMPUTER_USE_SETUP_TIMEOUT_SECONDS,
		},
		"ensuring computer use dependencies"
	);

	try {
		const markerCheck = await sandbox.process.executeCommand(
			`bash -lc 'if [ -f "${COMPUTER_USE_DEPENDENCIES_MARKER}" ]; then echo present; else echo missing; fi'`,
			undefined,
			undefined,
			COMPUTER_USE_MARKER_CHECK_TIMEOUT_SECONDS
		);
		const markerState = markerCheck.result.trim();
		log.info(
			{ sandboxId: sandbox.id, markerState },
			"computer use dependency marker check complete"
		);
		if (markerState === "present") {
			log.info(
				{
					sandboxId: sandbox.id,
					durationMs: Date.now() - startedAt,
				},
				"computer use dependencies already installed"
			);
			return;
		}
	} catch (error) {
		log.warn(
			{
				sandboxId: sandbox.id,
				err: error,
			},
			"computer use marker check failed, proceeding with install script"
		);
	}

	log.info({ sandboxId: sandbox.id }, "installing computer use dependencies");

	const script = [
		"set -euo pipefail",
		`MARKER="${COMPUTER_USE_DEPENDENCIES_MARKER}"`,
		'if [ -f "$MARKER" ]; then exit 0; fi',
		'if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi',
		"$SUDO apt-get update",
		"DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends \\",
		"\txvfb xfce4 xfce4-terminal x11vnc novnc websockify dbus-x11 \\",
		"\tlibx11-6 libxrandr2 libxext6 libxrender1 libxfixes3 libxss1 libxtst6 libxi6",
		'$SUDO touch "$MARKER"',
	].join("\n");

	const escapedScript = script.replaceAll("'", "'\\''");
	const result = await sandbox.process.executeCommand(
		`bash -lc '${escapedScript}'`,
		undefined,
		undefined,
		COMPUTER_USE_SETUP_TIMEOUT_SECONDS
	);

	if (result.exitCode !== 0) {
		const output = truncate(result.result);
		throw new Error(
			`Computer Use dependency installation failed (exit ${result.exitCode}): ${output || "No output"}`
		);
	}

	log.info(
		{
			sandboxId: sandbox.id,
			durationMs: Date.now() - startedAt,
		},
		"computer use dependencies ensured"
	);
}

export async function ensureComputerUseRunning(
	sandbox: Sandbox
): Promise<void> {
	log.info({ sandboxId: sandbox.id }, "ensuring computer use is running");
	await ensureComputerUseDependencies(sandbox);
	log.info({ sandboxId: sandbox.id }, "computer use dependency phase complete");

	log.info({ sandboxId: sandbox.id }, "starting computer use");
	for (let attempt = 1; attempt <= COMPUTER_USE_START_ATTEMPTS; attempt += 1) {
		const isRetry = attempt > 1;
		if (isRetry) {
			log.warn(
				{
					sandboxId: sandbox.id,
					attempt,
					maxAttempts: COMPUTER_USE_START_ATTEMPTS,
				},
				"retrying computer use start"
			);
		}

		try {
			const startResult = await withTimeout(
				"computerUse.start",
				sandbox.computerUse.start()
			);
			log.info(
				{
					sandboxId: sandbox.id,
					message: startResult.message,
				},
				"computer use start invoked"
			);
			break;
		} catch (error) {
			const canRetry =
				attempt < COMPUTER_USE_START_ATTEMPTS &&
				isServiceUnavailableError(error);

			log.error(
				{
					sandboxId: sandbox.id,
					stage: "start",
					attempt,
					err: getErrorLogDetails(error),
				},
				"computer use start failed"
			);

			if (!canRetry) {
				if (isServiceUnavailableError(error)) {
					log.warn(
						{ sandboxId: sandbox.id, err: getErrorLogDetails(error) },
						"computer use API unavailable, attempting manual fallback"
					);
					await ensureManualDesktopRunning(sandbox);
					return;
				}
				throw error;
			}

			await sleep(COMPUTER_USE_RETRY_DELAY_MS);
		}
	}

	log.info({ sandboxId: sandbox.id }, "checking computer use process health");
	let processStatuses: Array<{
		processName: (typeof COMPUTER_USE_PROCESSES)[number];
		status: Awaited<ReturnType<Sandbox["computerUse"]["getProcessStatus"]>>;
	}>;
	try {
		processStatuses = await Promise.all(
			COMPUTER_USE_PROCESSES.map(async (processName) => ({
				processName,
				status: await withTimeout(
					`computerUse.getProcessStatus(${processName})`,
					sandbox.computerUse.getProcessStatus(processName)
				),
			}))
		);
	} catch (error) {
		log.error(
			{
				sandboxId: sandbox.id,
				stage: "getProcessStatus",
				err: getErrorLogDetails(error),
			},
			"computer use process status read failed"
		);
		throw error;
	}

	log.info(
		{
			sandboxId: sandbox.id,
			processStatuses: processStatuses.map(({ processName, status }) => ({
				processName,
				running: status.running,
			})),
		},
		"computer use process status check complete"
	);

	const unhealthy = processStatuses.filter(({ status }) => !status.running);
	if (unhealthy.length === 0) {
		log.info({ sandboxId: sandbox.id }, "computer use ready");
		return;
	}

	const errorDetails = await Promise.all(
		unhealthy.map(async ({ processName }) => {
			try {
				const errors = await withTimeout(
					`computerUse.getProcessErrors(${processName})`,
					sandbox.computerUse.getProcessErrors(processName)
				);
				const snippet = truncate(errors.errors);
				return `${processName}: ${snippet || "no error output"}`;
			} catch (error) {
				const details = getErrorLogDetails(error);
				return `${processName}: failed to read process errors (${details.message})`;
			}
		})
	);
	log.error(
		{
			sandboxId: sandbox.id,
			unhealthyProcesses: unhealthy.map(({ processName }) => processName),
			errorDetails,
		},
		"computer use process health check failed"
	);

	throw new Error(
		`Computer Use is not healthy. Unhealthy processes: ${errorDetails.join("; ")}`
	);
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
