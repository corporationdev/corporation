#!/usr/bin/env bun

/**
 * Build, sync, and (optionally) watch sandbox-runtime on a running sandbox.
 *
 * Usage:
 *   bun scripts/dev-sandbox-runtime.ts <sandbox-id>              # build + sync + watch
 *   bun scripts/dev-sandbox-runtime.ts <sandbox-id> --no-watch   # build + sync once
 */

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

const srcDir = resolve(repoRoot, "packages/sandbox-runtime");
const bundlePath = resolve(srcDir, "dist/sandbox-runtime.js");
const setupPath = resolve(srcDir, "setup.sh");
const remoteBundlePath = "/usr/local/bin/sandbox-runtime.js";
const remoteSetupPath = "/usr/local/bin/sandbox-runtime-setup.sh";

const entrypoint = resolve(srcDir, "sandbox-runtime.ts");
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

async function buildAndSync() {
	if (syncing) {
		pendingSync = true;
		return;
	}
	syncing = true;
	stopTailing();

	try {
		const start = Date.now();

		// Build
		const build = Bun.spawnSync(buildCmd);
		if (build.exitCode !== 0) {
			console.error(`[build failed] ${build.stderr.toString().trim()}`);
			return;
		}

		// Stop running process
		await sandbox.commands.run(
			"tmux kill-session -t sandbox-agent 2>/dev/null || true",
			{ timeoutMs: 5000 }
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
		await sandbox.commands.run(": > /tmp/sandbox-runtime.log", {
			timeoutMs: 3000,
		});
		await sandbox.commands.run(
			`tmux new-session -d -s sandbox-agent "bun ${remoteBundlePath} --host 0.0.0.0 --port 5799"`,
			{ timeoutMs: 5000 }
		);

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

console.log(`[watching] packages/sandbox-runtime/ → sandbox ${sandboxId}`);

watch(srcDir, { recursive: true }, (_event, filename) => {
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
