import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Sandbox } from "e2b";
import { buildLocalProxyEnv, getLocalProxyConfig } from "../src/proxy-config";

const packageDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(packageDir, "../..");

config({
	path: resolve(repoRoot, "apps/server/.env"),
	override: false,
	quiet: true,
});
config({
	path: resolve(repoRoot, "apps/web/.env"),
	override: false,
	quiet: true,
});

const runtimeSessionName = "sandbox-runtime-test";
const remoteBundlePath = "/tmp/sandbox-runtime.integration.js";
const runtimeLogPath = "/tmp/sandbox-runtime.integration.log";
const runtimeStderrPath = "/tmp/sandbox-runtime.integration.stderr.log";
const LOCAL_RUNTIME_HOST = "127.0.0.1";

export type RuntimeCommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
};

export type RuntimeHarness = {
	mode: "local" | "sandbox";
	proxyConfig: ReturnType<typeof getLocalProxyConfig>;
	setup: () => Promise<void>;
	teardown: () => Promise<void>;
	run: (command: string, timeoutMs?: number) => Promise<RuntimeCommandResult>;
	runWithProxy: (
		command: string,
		timeoutMs?: number
	) => Promise<RuntimeCommandResult>;
};

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function randomPort(): number {
	return 20_000 + Math.floor(Math.random() * 20_000);
}

async function buildBundle(tempDir: string): Promise<string> {
	const entrypoint = resolve(packageDir, "src/index.ts");
	const bundlePath = resolve(tempDir, "sandbox-runtime.js");

	await mkdir(resolve(packageDir, "dist"), { recursive: true });

	const build = Bun.spawnSync([
		"bun",
		"build",
		entrypoint,
		"--outfile",
		bundlePath,
		"--target=bun",
	]);
	if (build.exitCode !== 0) {
		throw new Error(build.stderr.toString().trim() || "bun build failed");
	}

	return bundlePath;
}

async function waitForLocalRuntimeHealth(port: number): Promise<void> {
	const deadline = Date.now() + 30_000;

	while (Date.now() < deadline) {
		try {
			const response = await fetch(
				`http://${LOCAL_RUNTIME_HOST}:${port}/v1/health`
			);
			if (response.ok) {
				return;
			}
		} catch {
			// Ignore while starting
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	throw new Error("sandbox-runtime did not become healthy locally");
}

async function waitForSandboxRuntimeHealth(
	sandbox: Sandbox,
	port: number
): Promise<void> {
	const deadline = Date.now() + 30_000;

	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run(`curl -sf http://localhost:${port}/v1/health`, {
				timeoutMs: 3_000,
			});
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	const stderrOutput = await sandbox.commands
		.run(`cat ${runtimeStderrPath}`, { timeoutMs: 3_000 })
		.then((result) => result.stdout.trim())
		.catch(() => "");

	throw new Error(
		stderrOutput
			? `sandbox-runtime did not become healthy:\n${stderrOutput}`
			: "sandbox-runtime did not become healthy"
	);
}

function collectProcessOutput(stream: ReadableStream<Uint8Array> | null) {
	let buffer = "";
	if (!stream) {
		return {
			read: () => buffer,
		};
	}

	const reader = stream.getReader();
	const decoder = new TextDecoder();

	void (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
			}
		} catch {
			// ignore stream shutdown
		} finally {
			buffer += decoder.decode();
		}
	})();

	return {
		read: () => buffer,
	};
}

async function runLocalCommand(
	command: string,
	timeoutMs = 20_000,
	env: Record<string, string | undefined>
): Promise<RuntimeCommandResult> {
	const proc = Bun.spawn(["bash", "-lc", command], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});

	const timeout = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// ignore
		}
	}, timeoutMs);

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]).finally(() => clearTimeout(timeout));

	return { stdout, stderr, exitCode };
}

function buildPrefixedProxyCommand(
	command: string,
	proxyConfigEnv: Record<string, string>
): string {
	return `${Object.entries(proxyConfigEnv)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ")} ${command}`;
}

async function createLocalHarness(): Promise<RuntimeHarness> {
	const tempDir = await mkdtemp(resolve(tmpdir(), "sandbox-runtime-local-"));
	const bundlePath = await buildBundle(tempDir);
	const runtimePort = randomPort();
	const proxyPort = randomPort();
	const proxyStateDir = resolve(tempDir, "mitmproxy");
	const runtimeEnv = {
		...process.env,
		CORPORATION_PROXY_PORT: String(proxyPort),
		CORPORATION_PROXY_STATE_DIR: proxyStateDir,
	};
	const proxyConfig = getLocalProxyConfig(runtimeEnv);

	if (!Bun.which("mitmdump")) {
		throw new Error(
			[
				"Local sandbox-runtime proxy tests require `mitmdump` on PATH.",
				"Install it with one of:",
				"  uv tool install mitmproxy",
				"  pipx install mitmproxy",
			].join("\n")
		);
	}

	const runtimeProc = Bun.spawn(
		["bun", bundlePath, "--host", LOCAL_RUNTIME_HOST, "--port", String(runtimePort)],
		{
			env: runtimeEnv,
			stdout: "pipe",
			stderr: "pipe",
		}
	);
	const stdout = collectProcessOutput(runtimeProc.stdout);
	const stderr = collectProcessOutput(runtimeProc.stderr);

	return {
		mode: "local",
		proxyConfig,
		setup: async () => {
			await waitForLocalRuntimeHealth(runtimePort);
		},
		teardown: async () => {
			try {
				runtimeProc.kill();
			} catch {
				// ignore
			}
			await runtimeProc.exited.catch(() => undefined);
			if (existsSync(tempDir)) {
				await rm(tempDir, { recursive: true, force: true });
			}
		},
		run: async (command: string, timeoutMs?: number) => {
			const result = await runLocalCommand(command, timeoutMs, process.env);
			if (result.exitCode !== 0) {
				return {
					...result,
					stderr: [result.stderr, stdout.read(), stderr.read()]
						.filter((part) => part && part.trim().length > 0)
						.join("\n"),
				};
			}
			return result;
		},
		runWithProxy: async (command: string, timeoutMs?: number) =>
			runLocalCommand(command, timeoutMs, {
				...process.env,
				...buildLocalProxyEnv(runtimeEnv),
			}),
	};
}

async function createSandboxHarness(): Promise<RuntimeHarness> {
	const apiKey = process.env.E2B_API_KEY;
	if (!apiKey) {
		throw new Error("Missing E2B_API_KEY for sandbox integration tests");
	}

	const template = process.env.E2B_BASE_TEMPLATE_ID || "corporation-base";
	const tempDir = await mkdtemp(resolve(tmpdir(), "sandbox-runtime-sandbox-"));
	const bundlePath = await buildBundle(tempDir);
	const bundleData = await readFile(bundlePath);
	const runtimePort = 5799;
	const proxyPort = 8877;
	const proxyStateDir = "/tmp/corporation-mitmproxy";
	const runtimeEnv = {
		CORPORATION_PROXY_PORT: String(proxyPort),
		CORPORATION_PROXY_STATE_DIR: proxyStateDir,
	};
	const proxyConfig = getLocalProxyConfig(runtimeEnv);
	const sandbox = await Sandbox.create(template, {
		apiKey,
		timeoutMs: 15 * 60_000,
		network: { allowPublicTraffic: true },
	});

	return {
		mode: "sandbox",
		proxyConfig,
		setup: async () => {
			await sandbox.files.write([
				{ path: remoteBundlePath, data: new Blob([bundleData]) },
			]);
			await sandbox.commands.run(
				`tmux kill-session -t ${runtimeSessionName} || true`,
				{
					timeoutMs: 5_000,
				}
			);
			await sandbox.commands.run(`fuser -k ${runtimePort}/tcp || true`, {
				timeoutMs: 5_000,
			});
			await sandbox.commands.run(
				`: > ${runtimeLogPath}; : > ${runtimeStderrPath}`,
				{
					timeoutMs: 3_000,
				}
			);
			await sandbox.commands.run(
				`${Object.entries(runtimeEnv)
					.map(([key, value]) => `${key}=${shellQuote(value)}`)
					.join(" ")} tmux new-session -d -s ${runtimeSessionName} "bun ${remoteBundlePath} --host 0.0.0.0 --port ${runtimePort} >> ${runtimeLogPath} 2>> ${runtimeStderrPath}"`,
				{ timeoutMs: 5_000 }
			);
			await waitForSandboxRuntimeHealth(sandbox, runtimePort);
		},
		teardown: async () => {
			await Sandbox.kill(sandbox.sandboxId).catch(() => undefined);
			if (existsSync(tempDir)) {
				await rm(tempDir, { recursive: true, force: true });
			}
		},
		run: async (command: string, timeoutMs?: number) => {
			const result = await sandbox.commands.run(command, {
				timeoutMs,
			});
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: 0,
			};
		},
		runWithProxy: async (command: string, timeoutMs?: number) => {
			const result = await sandbox.commands.run(
				buildPrefixedProxyCommand(command, buildLocalProxyEnv(runtimeEnv)),
				{
					timeoutMs,
				}
			);
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: 0,
			};
		},
	};
}

export async function createRuntimeHarness(): Promise<RuntimeHarness> {
	const mode = process.env.SANDBOX_RUNTIME_TEST_TARGET === "sandbox"
		? "sandbox"
		: "local";
	return mode === "sandbox"
		? await createSandboxHarness()
		: await createLocalHarness();
}
