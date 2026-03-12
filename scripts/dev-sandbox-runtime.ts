#!/usr/bin/env bun

/**
 * Build, sync, and (optionally) watch sandbox-runtime on a running sandbox.
 *
 * Usage:
 *   bun scripts/dev-sandbox-runtime.ts <sandbox-id>              # build + sync + watch
 *   bun scripts/dev-sandbox-runtime.ts <sandbox-id> --no-watch   # build + sync once
 */

import { existsSync, watch } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";
import { config } from "dotenv";
import { Sandbox } from "e2b";

const repoRoot = resolve(import.meta.dirname, "..");
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

const encoder = new TextEncoder();

function base64url(input: string): string {
	return btoa(input)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll(/=+$/g, "");
}

async function createDevRefreshToken(params: {
	spaceSlug: string;
	sandboxId: string;
}): Promise<string> {
	const secret = process.env.CORPORATION_RUNTIME_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error(
			"Missing CORPORATION_RUNTIME_AUTH_SECRET — set it in apps/server/.env"
		);
	}

	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			sub: "dev",
			spaceSlug: params.spaceSlug,
			sandboxId: params.sandboxId,
			clientType: "sandbox_runtime",
			tokenType: "refresh",
			aud: "space-runtime-refresh",
			exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
			iat: Math.floor(Date.now() / 1000),
		})
	);
	const signingInput = `${header}.${payload}`;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput))
	);
	let signatureBinary = "";
	for (const byte of signature) {
		signatureBinary += String.fromCharCode(byte);
	}
	return `${signingInput}.${base64url(signatureBinary)}`;
}

const argv = process.argv.slice(2);
const noWatch = argv.includes("--no-watch");
const sandboxId = argv.find((arg) => !arg.startsWith("--"));

if (!sandboxId) {
	console.error(
		[
			"Missing sandbox id.",
			"Usage:",
			"  bun scripts/dev-sandbox-runtime.ts <sandbox-id>",
			"  bun scripts/dev-sandbox-runtime.ts <sandbox-id> --no-watch",
		].join("\n")
	);
	process.exit(1);
}
if (!process.env.E2B_API_KEY) {
	console.error(
		[
			"Missing E2B_API_KEY.",
			"Set it in your environment or add it to apps/server/.env (the script auto-loads that file).",
		].join("\n")
	);
	process.exit(1);
}

const sandboxRuntimeDir = [
	resolve(repoRoot, "apps/sandbox-runtime"),
	resolve(repoRoot, "packages/sandbox-runtime"),
].find((path) => existsSync(path));

const bundleDir = resolve(sandboxRuntimeDir, "dist/runtime");
const setupPath = resolve(sandboxRuntimeDir, "setup.sh");
const remoteBundlePath = "/usr/local/bin/sandbox-runtime.js";
const remoteSetupPath = "/usr/local/bin/sandbox-runtime-setup.sh";
const runtimeLogPath = "/tmp/sandbox-runtime.log";
const runtimeStderrPath = "/tmp/sandbox-runtime.stderr.log";
const runtimeSessionName = "sandbox-agent";

const entrypoint = resolve(sandboxRuntimeDir, "src/index.ts");
const buildCmd = [
	"bun",
	"build",
	entrypoint,
	"--outdir",
	bundleDir,
	"--target=bun",
];

const sandbox = await Sandbox.connect(sandboxId);

let syncing = false;
let pendingSync = false;
let logTailTimer: ReturnType<typeof setInterval> | null = null;
let logOffset = 0;
let proxyLogTailTimer: ReturnType<typeof setInterval> | null = null;
let proxyLogOffset = 0;
const proxyLogPath = "/tmp/corporation-mitmproxy.log";

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function startTailing() {
	logOffset = 0;
	logTailTimer = setInterval(async () => {
		try {
			const result = await sandbox.commands.run(
				"wc -c < /tmp/sandbox-runtime.log 2>/dev/null || echo 0",
				{ timeoutMs: 3000 }
			);
			const size = Number.parseInt(result.stdout.trim(), 10);
			if (size > logOffset) {
				const chunk = await sandbox.commands.run(
					`tail -c +${logOffset + 1} /tmp/sandbox-runtime.log`,
					{ timeoutMs: 3000 }
				);
				process.stdout.write(chunk.stdout);
				logOffset = size;
			}
		} catch {
			// sandbox might be busy
		}
	}, 1000);

	proxyLogOffset = 0;
	proxyLogTailTimer = setInterval(async () => {
		try {
			const result = await sandbox.commands.run(
				`wc -c < ${proxyLogPath} 2>/dev/null || echo 0`,
				{ timeoutMs: 3000 }
			);
			const size = Number.parseInt(result.stdout.trim(), 10);
			if (size > proxyLogOffset) {
				const chunk = await sandbox.commands.run(
					`tail -c +${proxyLogOffset + 1} ${proxyLogPath}`,
					{ timeoutMs: 3000 }
				);
				process.stdout.write(chunk.stdout);
				proxyLogOffset = size;
			}
		} catch {
			// sandbox might be busy
		}
	}, 1000);
}

function stopTailing() {
	if (logTailTimer) {
		clearInterval(logTailTimer);
		logTailTimer = null;
	}
	if (proxyLogTailTimer) {
		clearInterval(proxyLogTailTimer);
		proxyLogTailTimer = null;
	}
}

async function getSandboxServerUrl(): Promise<string | null> {
	if (process.env.CORPORATION_SERVER_URL?.trim()) {
		return process.env.CORPORATION_SERVER_URL.trim();
	}

	const result = await sandbox.commands
		.run("printenv CORPORATION_SERVER_URL", { timeoutMs: 5000 })
		.then((output) => output.stdout.trim())
		.catch(() => "");

	return result || null;
}

async function getSandboxRuntimeEnv(name: string): Promise<string> {
	const localValue = process.env[name]?.trim();
	if (localValue) {
		return localValue;
	}

	const tmuxValue = await sandbox.commands
		.run(
			`tmux show-environment -t ${runtimeSessionName} ${shellEscape(name)} 2>/dev/null || true`,
			{ timeoutMs: 5000 }
		)
		.then((output) => output.stdout.trim())
		.catch(() => "");
	if (tmuxValue.startsWith(`${name}=`)) {
		const value = tmuxValue.slice(`${name}=`.length).trim();
		if (value) {
			return value;
		}
	}

	const envValue = await sandbox.commands
		.run(`printenv ${shellEscape(name)}`, { timeoutMs: 5000 })
		.then((output) => output.stdout.trim())
		.catch(() => "");
	if (envValue) {
		return envValue;
	}

	throw new Error(
		[
			`Unable to determine ${name} for sandbox-runtime dev sync.`,
			`Provision a fresh sandbox after the runtime auth changes, or set ${name} locally before running \`bun dev:sandbox-runtime\`.`,
		].join("\n")
	);
}

async function waitForRuntimeHealth(): Promise<void> {
	const deadline = Date.now() + 15_000;
	let lastError: unknown = null;

	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run("curl -sf http://localhost:5799/health", {
				timeoutMs: 3000,
			});
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	const tmuxSession = await sandbox.commands
		.run(`tmux has-session -t ${runtimeSessionName}`, { timeoutMs: 3000 })
		.then(() => "tmux session exists")
		.catch(() => "tmux session missing");
	const stderrOutput = await sandbox.commands
		.run(`cat ${runtimeStderrPath}`, { timeoutMs: 3000 })
		.then((result) => result.stdout.trim())
		.catch(() => "");

	const reason =
		lastError instanceof Error
			? lastError.message
			: String(lastError ?? "unknown");
	throw new Error(
		[
			`sandbox-runtime did not become healthy: ${reason}`,
			tmuxSession,
			stderrOutput ? `stderr: ${stderrOutput}` : null,
		]
			.filter(Boolean)
			.join("\n")
	);
}

async function buildAndSync() {
	if (syncing) {
		pendingSync = true;
		return;
	}
	syncing = true;
	stopTailing();

	try {
		const start = Date.now();

		await rm(bundleDir, { recursive: true, force: true });
		await mkdir(bundleDir, { recursive: true });

		// Build
		const build = Bun.spawnSync(buildCmd);
		if (build.exitCode !== 0) {
			console.error(`[build failed] ${build.stderr.toString().trim()}`);
			return;
		}

		// Stop running process (keep tmux session alive to preserve env)
		await sandbox.commands.run("fuser -k 5799/tcp 2>/dev/null; true", {
			timeoutMs: 5000,
		});

		// Upload bundle artifacts + setup script
		const [bundleArtifacts, setupData] = await Promise.all([
			readdir(bundleDir),
			readFile(setupPath),
		]);
		const bundleWrites = await Promise.all(
			bundleArtifacts.map(async (artifact) => {
				const localPath = resolve(bundleDir, artifact);
				const remotePath =
					artifact === "index.js"
						? remoteBundlePath
						: `/usr/local/bin/${artifact}`;
				return {
					path: remotePath,
					data: await readFile(localPath),
				};
			})
		);
		await sandbox.files.write([
			...bundleWrites,
			{ path: remoteSetupPath, data: setupData },
		]);

		// Run setup
		await sandbox.commands.run(`bash ${remoteSetupPath}`, {
			timeoutMs: 60_000,
		});

		// Truncate log and restart inside existing tmux session
		await sandbox.commands.run(
			`: > ${runtimeLogPath}; : > ${runtimeStderrPath}`,
			{
				timeoutMs: 3000,
			}
		);

		const runtimeCmd = `bun ${shellEscape(remoteBundlePath)} --host 0.0.0.0 --port 5799 >> ${shellEscape(runtimeLogPath)} 2>> ${shellEscape(runtimeStderrPath)}`;

		// Check if tmux session exists; reuse it to preserve env vars (auth token etc.)
		const hasSession = await sandbox.commands
			.run(`tmux has-session -t ${runtimeSessionName} 2>/dev/null`, {
				timeoutMs: 3000,
			})
			.then(() => true)
			.catch(() => false);

		if (hasSession) {
			// Respawn pane in existing session — new process inherits session env
			// vars (auth token etc.) set via `tmux set-environment`
			await sandbox.commands.run(
				`tmux respawn-pane -k -t ${runtimeSessionName} ${shellEscape(runtimeCmd)}`,
				{ timeoutMs: 5000 }
			);
		} else {
			// First run or session was lost — resolve env vars and mint a fresh token
			const runtimeServerUrl = await getSandboxServerUrl();
			const runtimeSpaceSlug = await getSandboxRuntimeEnv(
				"CORPORATION_SPACE_SLUG"
			);
			const runtimeRefreshToken = await createDevRefreshToken({
				spaceSlug: runtimeSpaceSlug,
				sandboxId,
			});
			// Create session and persist env vars for future respawn-pane reuse
			await sandbox.commands.run(
				`tmux new-session -d -s ${shellEscape(runtimeSessionName)} "CORPORATION_SERVER_URL=${shellEscape(runtimeServerUrl ?? "")} CORPORATION_SPACE_SLUG=${shellEscape(runtimeSpaceSlug)} CORPORATION_RUNTIME_REFRESH_TOKEN=${shellEscape(runtimeRefreshToken)} CORPORATION_SANDBOX_ID=${shellEscape(sandboxId)} ${runtimeCmd}"`,
				{ timeoutMs: 5000 }
			);
			// Persist into tmux session env so respawn-pane inherits them
			for (const [name, value] of Object.entries({
				CORPORATION_SERVER_URL: runtimeServerUrl ?? "",
				CORPORATION_SPACE_SLUG: runtimeSpaceSlug,
				CORPORATION_RUNTIME_REFRESH_TOKEN: runtimeRefreshToken,
				CORPORATION_SANDBOX_ID: sandboxId,
			})) {
				await sandbox.commands.run(
					`tmux set-environment -t ${shellEscape(runtimeSessionName)} ${shellEscape(name)} ${shellEscape(value)}`,
					{ timeoutMs: 3000 }
				);
			}
		}
		await waitForRuntimeHealth();

		const elapsed = Date.now() - start;
		console.log(`[synced] ${elapsed}ms`);

		if (!noWatch) {
			startTailing();
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[sync failed] ${msg}`);
		if (noWatch) {
			process.exit(1);
		}
	} finally {
		syncing = false;
		if (pendingSync) {
			pendingSync = false;
			buildAndSync();
		}
	}
}

// Initial build + sync
await buildAndSync();

if (noWatch) {
	console.log("Done (--no-watch).");
	process.exit(0);
}

// Watch for changes — debounce rapid saves
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

console.log(
	`[watching] ${relative(repoRoot, sandboxRuntimeDir)}/ → sandbox ${sandboxId}`
);

watch(sandboxRuntimeDir, { recursive: true }, (_event, filename) => {
	if (!filename) {
		return;
	}
	// Skip dist/ output and dotfiles
	if (filename.startsWith("dist/") || filename.startsWith(".")) {
		return;
	}

	if (debounceTimer) {
		clearTimeout(debounceTimer);
	}
	debounceTimer = setTimeout(() => {
		console.log(`[changed] ${filename}`);
		buildAndSync();
	}, 200);
});
