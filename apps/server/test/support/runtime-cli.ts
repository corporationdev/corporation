import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export type SpawnedCli = {
	output: {
		stdout: string;
		stderr: string;
	};
	process: ChildProcess;
	stop: () => Promise<void>;
	waitForOutput: (pattern: string, timeoutMs?: number) => Promise<void>;
};

function getRepoRoot(): string {
	return new URL("../../../../", import.meta.url).pathname;
}

function getBunBin(): string {
	return process.env.BUN_BINARY?.trim() || "bun";
}

function createCliEnv(): Record<string, string> {
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

function attachOutput(process: ChildProcess) {
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
		sleep(5_000).then(() => "timeout"),
	]);
	if (result === "timeout") {
		process.kill("SIGKILL");
		await waitForExit(process);
	}
}

async function waitForOutput(
	process: ChildProcess,
	output: { stdout: string; stderr: string },
	pattern: string,
	timeoutMs: number
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (
			output.stdout.includes(pattern) ||
			output.stderr.includes(pattern)
		) {
			return;
		}
		if (process.exitCode !== null) {
			throw new Error(
				`CLI exited before output "${pattern}" appeared.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`
			);
		}
		await sleep(100);
	}

	throw new Error(
		`Timed out waiting for CLI output "${pattern}".\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`
	);
}

export function spawnRuntimeCli(args: string[]): SpawnedCli {
	const child = spawn(getBunBin(), ["apps/sandbox-runtime/cli.ts", ...args], {
		cwd: getRepoRoot(),
		env: createCliEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = attachOutput(child);

	return {
		output,
		process: child,
		stop: async () => {
			await stopProcess(child);
		},
		waitForOutput: async (pattern: string, timeoutMs = 30_000) => {
			await waitForOutput(child, output, pattern, timeoutMs);
		},
	};
}
