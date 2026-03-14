import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

type ProcessOutput = {
	stdout: string;
	stderr: string;
};

export type WranglerDevHarness = {
	output: Readonly<ProcessOutput>;
	port: number;
	serverUrl: string;
	stop: () => Promise<void>;
	waitUntilReady: (pathname?: string, timeoutMs?: number) => Promise<void>;
};

type StartWranglerDevOptions = {
	configPath?: string;
	cwd?: string;
	ip?: string;
	logLevel?: "debug" | "info" | "log" | "warn" | "error" | "none";
	port?: number;
	readyPath?: string;
};

const DEFAULT_READY_PATH = "/api/health";
const DEFAULT_READY_TIMEOUT_MS = 30_000;

function getServerDir(): string {
	return new URL("../../", import.meta.url).pathname;
}

function getWranglerBin(): string {
	return new URL("../../node_modules/.bin/wrangler", import.meta.url).pathname;
}

function createWranglerEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of [
		"HOME",
		"LOGNAME",
		"PATH",
		"SHELL",
		"TERM",
		"TMPDIR",
		"USER",
	]) {
		const value = process.env[key];
		if (value) {
			env[key] = value;
		}
	}
	return env;
}

function attachOutput(process: ChildProcess): ProcessOutput {
	let stdout = "";
	let stderr = "";

	process.stdout?.setEncoding("utf8");
	process.stderr?.setEncoding("utf8");
	process.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	process.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});

	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

async function getAvailablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!(address && typeof address === "object")) {
				server.close();
				reject(new Error("Failed to allocate an ephemeral port"));
				return;
			}

			const { port } = address;
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(port);
			});
		});
		server.on("error", reject);
	});
}

function waitForExit(process: ChildProcess): Promise<number | null> {
	return new Promise((resolve) => {
		process.once("exit", (code) => {
			resolve(code);
		});
	});
}

async function stopProcess(process: ChildProcess): Promise<void> {
	if (process.exitCode !== null || process.killed) {
		return;
	}

	process.kill("SIGTERM");
	const result = await Promise.race([
		waitForExit(process),
		sleep(5000).then(() => "timeout"),
	]);
	if (result === "timeout") {
		process.kill("SIGKILL");
		await waitForExit(process);
	}
}

async function waitForHttpReady(
	serverUrl: string,
	pathname: string,
	output: ProcessOutput,
	process: ChildProcess,
	timeoutMs: number
): Promise<void> {
	const url = new URL(pathname, serverUrl).toString();
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const response = await fetch(url);
			if (response.status > 0) {
				return;
			}
		} catch {
			// Keep polling until the Worker is ready.
		}

		if (process.exitCode !== null) {
			throw new Error(
				`Wrangler dev exited before becoming ready.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`
			);
		}

		await sleep(250);
	}

	throw new Error(
		`Timed out waiting for wrangler dev at ${url}.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`
	);
}

export async function startWranglerDev(
	options: StartWranglerDevOptions = {}
): Promise<WranglerDevHarness> {
	const port = options.port ?? (await getAvailablePort());
	const ip = options.ip ?? "127.0.0.1";
	const cwd = options.cwd ?? getServerDir();
	const child = spawn(
		getWranglerBin(),
		[
			"dev",
			"--config",
			options.configPath ?? "wrangler.test.jsonc",
			"--ip",
			ip,
			"--port",
			String(port),
			"--log-level",
			options.logLevel ?? "error",
		],
		{
			cwd,
			env: createWranglerEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		}
	);
	const output = attachOutput(child);
	const serverUrl = `http://${ip}:${port}`;

	await waitForHttpReady(
		serverUrl,
		options.readyPath ?? DEFAULT_READY_PATH,
		output,
		child,
		DEFAULT_READY_TIMEOUT_MS
	);

	return {
		output,
		port,
		serverUrl,
		stop: async () => {
			await stopProcess(child);
		},
		waitUntilReady: async (
			pathname = options.readyPath ?? DEFAULT_READY_PATH,
			timeoutMs = DEFAULT_READY_TIMEOUT_MS
		) => {
			await waitForHttpReady(serverUrl, pathname, output, child, timeoutMs);
		},
	};
}
