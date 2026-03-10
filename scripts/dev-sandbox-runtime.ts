#!/usr/bin/env bun

/**
 * Build, sync, and (optionally) watch sandbox-runtime on a running sandbox.
 *
 * Usage:
 *   bun scripts/dev-sandbox-runtime.ts <sandbox-id>              # build + sync + watch
 *   bun scripts/dev-sandbox-runtime.ts <sandbox-id> --no-watch   # build + sync once
 */

import { existsSync, watch } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
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

const bundlePath = resolve(sandboxRuntimeDir, "dist/sandbox-runtime.js");
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
	"--outfile",
	bundlePath,
	"--target=bun",
];

const sandbox = await Sandbox.connect(sandboxId);

let syncing = false;
let pendingSync = false;
let logTailTimer: ReturnType<typeof setInterval> | null = null;
let logOffset = 0;

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
}

function stopTailing() {
	if (logTailTimer) {
		clearInterval(logTailTimer);
		logTailTimer = null;
	}
}

async function getSandboxOwnerId(): Promise<string> {
	if (process.env.CORPORATION_SANDBOX_OWNER_ID?.trim()) {
		return process.env.CORPORATION_SANDBOX_OWNER_ID.trim();
	}

	const result = await sandbox.commands.run(
		"printenv CORPORATION_SANDBOX_OWNER_ID",
		{ timeoutMs: 5000 }
	);
	const ownerId = result.stdout.trim();
	if (!ownerId) {
		throw new Error(
			[
				"Unable to determine CORPORATION_SANDBOX_OWNER_ID for sandbox-runtime dev sync.",
				"Provision a fresh sandbox after the auth changes, or set CORPORATION_SANDBOX_OWNER_ID locally before running `bun dev:sandbox-runtime`.",
			].join("\n")
		);
	}
	return ownerId;
}

async function getSandboxConvexSiteUrl(): Promise<string> {
	if (process.env.CORPORATION_CONVEX_SITE_URL?.trim()) {
		return process.env.CORPORATION_CONVEX_SITE_URL.trim();
	}

	const result = await sandbox.commands.run(
		"printenv CORPORATION_CONVEX_SITE_URL",
		{ timeoutMs: 5000 }
	);
	const value = result.stdout.trim();
	if (!value) {
		throw new Error(
			[
				"Unable to determine CORPORATION_CONVEX_SITE_URL for sandbox-runtime dev sync.",
				"Provision a fresh sandbox after the auth changes, or set CORPORATION_CONVEX_SITE_URL locally before running `bun dev:sandbox-runtime`.",
			].join("\n")
		);
	}
	return value;
}

async function waitForRuntimeHealth(): Promise<void> {
	const deadline = Date.now() + 15_000;
	let lastError: unknown = null;

	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run("curl -sf http://localhost:5799/v1/health", {
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
		const ownerUserId = await getSandboxOwnerId();
		const runtimeConvexSiteUrl = await getSandboxConvexSiteUrl();

		await mkdir(resolve(sandboxRuntimeDir, "dist"), { recursive: true });

		// Build
		const build = Bun.spawnSync(buildCmd);
		if (build.exitCode !== 0) {
			console.error(`[build failed] ${build.stderr.toString().trim()}`);
			return;
		}

		// Stop running process
		await sandbox.commands.run("fuser -k 5799/tcp 2>/dev/null; true", {
			timeoutMs: 5000,
		});
		await sandbox.commands.run(
			`tmux kill-session -t ${runtimeSessionName} || true`,
			{
				timeoutMs: 5000,
			}
		);

		// Upload bundle + setup script
		const [bundleData, setupData] = await Promise.all([
			readFile(bundlePath),
			readFile(setupPath),
		]);
		await sandbox.files.write([
			{ path: remoteBundlePath, data: bundleData },
			{ path: remoteSetupPath, data: setupData },
		]);

		// Run setup
		await sandbox.commands.run(`bash ${remoteSetupPath}`, {
			timeoutMs: 60_000,
		});

		// Truncate log and restart
		await sandbox.commands.run(
			`: > ${runtimeLogPath}; : > ${runtimeStderrPath}`,
			{
				timeoutMs: 3000,
			}
		);
		await sandbox.commands.run(
			`tmux new-session -d -s ${runtimeSessionName} "CORPORATION_CONVEX_SITE_URL='${runtimeConvexSiteUrl}' CORPORATION_SANDBOX_OWNER_ID='${ownerUserId}' bun ${remoteBundlePath} --host 0.0.0.0 --port 5799 >> ${runtimeLogPath} 2>> ${runtimeStderrPath}"`,
			{ timeoutMs: 5000 }
		);
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
