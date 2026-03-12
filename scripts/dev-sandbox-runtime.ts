#!/usr/bin/env bun

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";
import { config } from "dotenv";
import { Sandbox } from "e2b";
import {
	getSandboxRuntimeSourceDir,
	getSandboxRuntimeStagingDir,
	packSandboxRuntimePackage,
} from "./lib/sandbox-runtime-package";

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
const sandboxRuntimeDir = getSandboxRuntimeSourceDir();
const sandboxRuntimeDistDir = getSandboxRuntimeStagingDir();
const runtimeSessionName = "sandbox-agent";
const runtimeLogPath = "/tmp/sandbox-runtime.log";
const runtimeStderrPath = "/tmp/sandbox-runtime.stderr.log";
const proxyLogPath = "/tmp/corporation-mitmproxy.log";
const activeRuntimeBin = "/usr/local/bin/sandbox-runtime";
const installRoot = "/opt/corporation/sandbox-runtime";
const remoteTarballPath = "/tmp/corporation-sandbox-runtime.tgz";
const sandboxUser = "user";
const sandboxWorkdir = "/workspace";
const runtimePort = 5799;

function base64url(input: string) {
	return btoa(input)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll(/=+$/g, "");
}

async function createDevRefreshToken(params: {
	spaceSlug: string;
	sandboxId: string;
}) {
	const secret = process.env.CORPORATION_RUNTIME_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error(
			"Missing CORPORATION_RUNTIME_AUTH_SECRET. Set it in apps/server/.env."
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

function shellEscape(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const argv = process.argv.slice(2);
const sandboxId = argv.find((arg, index) => {
	if (arg.startsWith("--")) {
		return false;
	}
	const previous = argv[index - 1];
	return previous !== "--version";
});
const noWatch = argv.includes("--no-watch");
const versionFlagIndex = argv.indexOf("--version");
const requestedVersion =
	versionFlagIndex >= 0 ? argv[versionFlagIndex + 1]?.trim() : undefined;

if (!sandboxId) {
	console.error(
		[
			"Missing sandbox id.",
			"Usage:",
			"  bun scripts/dev-sandbox-runtime.ts <sandbox-id>",
			"  bun scripts/dev-sandbox-runtime.ts <sandbox-id> --no-watch",
			"  bun scripts/dev-sandbox-runtime.ts <sandbox-id> --version <x.y.z> --no-watch",
		].join("\n")
	);
	process.exit(1);
}

if (versionFlagIndex >= 0 && !requestedVersion) {
	console.error("Missing version value after --version");
	process.exit(1);
}

if (requestedVersion && !noWatch) {
	console.error("--version is a one-shot validation mode. Add --no-watch.");
	process.exit(1);
}

if (!process.env.E2B_API_KEY) {
	console.error(
		"Missing E2B_API_KEY. Set it in your environment or apps/server/.env."
	);
	process.exit(1);
}

const sandbox = await Sandbox.connect(sandboxId);

let syncing = false;
let pendingSync = false;
let tailTimer: ReturnType<typeof setInterval> | null = null;
const logOffsets = new Map<string, number>();

async function runSandboxCommand(
	command: string,
	options: Omit<
		NonNullable<Parameters<Sandbox["commands"]["run"]>[1]>,
		"user"
	> & { user?: "root" | "user" } = {}
) {
	return await sandbox.commands.run(command, {
		timeoutMs: options.timeoutMs,
		cwd: options.cwd,
		envs: options.envs,
		user: options.user ?? "root",
	});
}

async function getSandboxEnv(name: string) {
	const localValue = process.env[name]?.trim();
	if (localValue) {
		return localValue;
	}

	const envValue = await runSandboxCommand(`printenv ${shellEscape(name)}`, {
		timeoutMs: 5000,
	})
		.then((output) => output.stdout.trim())
		.catch(() => "");
	if (envValue) {
		return envValue;
	}

	throw new Error(
		`Unable to determine ${name} for sandbox-runtime remote dev.`
	);
}

function startTailing() {
	for (const path of [runtimeLogPath, runtimeStderrPath, proxyLogPath]) {
		logOffsets.set(path, 0);
	}

	tailTimer = setInterval(async () => {
		for (const path of [runtimeLogPath, runtimeStderrPath, proxyLogPath]) {
			try {
				const currentOffset = logOffsets.get(path) ?? 0;
				const sizeResult = await runSandboxCommand(
					`wc -c < ${shellEscape(path)} 2>/dev/null || echo 0`,
					{ timeoutMs: 3000 }
				);
				const size = Number.parseInt(sizeResult.stdout.trim(), 10);
				if (size > currentOffset) {
					const chunk = await runSandboxCommand(
						`tail -c +${currentOffset + 1} ${shellEscape(path)}`,
						{ timeoutMs: 3000 }
					);
					process.stdout.write(chunk.stdout);
					logOffsets.set(path, size);
				}
			} catch {
				// Best effort tailing while the sandbox restarts.
			}
		}
	}, 1000);
}

function stopTailing() {
	if (tailTimer) {
		clearInterval(tailTimer);
		tailTimer = null;
	}
}

function triggerSync() {
	syncRuntime().catch((error) => {
		console.error(
			`[sync failed] ${error instanceof Error ? error.message : String(error)}`
		);
	});
}

async function waitForRuntimeHealth() {
	const deadline = Date.now() + 20_000;
	let lastError: unknown = null;

	while (Date.now() < deadline) {
		try {
			await runSandboxCommand(
				`curl -sf http://localhost:${runtimePort}/health`,
				{
					timeoutMs: 3000,
				}
			);
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	const stderrOutput = await runSandboxCommand(
		`cat ${shellEscape(runtimeStderrPath)}`,
		{
			timeoutMs: 3000,
		}
	)
		.then((result) => result.stdout.trim())
		.catch(() => "");
	throw new Error(
		[
			`sandbox-runtime did not become healthy: ${
				lastError instanceof Error
					? lastError.message
					: String(lastError ?? "unknown")
			}`,
			stderrOutput ? `stderr: ${stderrOutput}` : null,
		]
			.filter(Boolean)
			.join("\n")
	);
}

function createInstallCommand(input: { source: string; prefix: string }) {
	return `mkdir -p ${shellEscape(input.prefix)} && npm install -g --prefix ${shellEscape(input.prefix)} ${shellEscape(input.source)}`;
}

async function installAndRestartRuntime() {
	const startedAt = Date.now();
	const serverUrl = await getSandboxEnv("CORPORATION_SERVER_URL");
	const convexSiteUrl = await getSandboxEnv("CORPORATION_CONVEX_SITE_URL");
	const spaceSlug = await getSandboxEnv("CORPORATION_SPACE_SLUG");
	const refreshToken = await createDevRefreshToken({
		spaceSlug,
		sandboxId,
	});

	let installPrefix = `${installRoot}/dev-local`;
	let installSource = remoteTarballPath;
	let installLabel = "local-tarball";

	if (requestedVersion) {
		installPrefix = `${installRoot}/${requestedVersion}`;
		installSource = `@isaacdyor/sandbox-runtime@${requestedVersion}`;
		installLabel = requestedVersion;
	} else {
		const packResult = await packSandboxRuntimePackage();
		const tarballData = await readFile(packResult.tarballPath);
		await sandbox.files.write([
			{
				path: remoteTarballPath,
				data: tarballData,
			},
		]);
		console.log(`[packed] ${packResult.tarballPath}`);
	}

	await runSandboxCommand(
		createInstallCommand({
			source: installSource,
			prefix: installPrefix,
		}),
		{
			timeoutMs: 120_000,
			cwd: "/",
			user: "root",
		}
	);
	await runSandboxCommand(
		`mkdir -p /usr/local/bin && ln -sf ${shellEscape(`${installPrefix}/bin/sandbox-runtime`)} ${shellEscape(activeRuntimeBin)}`,
		{
			timeoutMs: 5000,
			user: "root",
		}
	);
	await runSandboxCommand(`test -x ${shellEscape(activeRuntimeBin)}`, {
		timeoutMs: 5000,
		user: "root",
	});

	await runSandboxCommand(
		`tmux kill-session -t ${shellEscape(runtimeSessionName)} || true`,
		{
			timeoutMs: 5000,
			cwd: sandboxWorkdir,
			user: sandboxUser,
		}
	);
	await runSandboxCommand(`fuser -k ${runtimePort}/tcp 2>/dev/null || true`, {
		timeoutMs: 5000,
		user: "root",
	});
	await runSandboxCommand(`: > ${runtimeLogPath}; : > ${runtimeStderrPath}`, {
		timeoutMs: 3000,
		cwd: sandboxWorkdir,
		user: sandboxUser,
	});

	const runtimeCommand = `CORPORATION_SERVER_URL=${shellEscape(serverUrl)} CORPORATION_CONVEX_SITE_URL=${shellEscape(convexSiteUrl)} CORPORATION_SPACE_SLUG=${shellEscape(spaceSlug)} CORPORATION_RUNTIME_REFRESH_TOKEN=${shellEscape(refreshToken)} CORPORATION_SANDBOX_ID=${shellEscape(sandboxId)} ${activeRuntimeBin} --host 0.0.0.0 --port ${runtimePort} >> ${shellEscape(runtimeLogPath)} 2>> ${shellEscape(runtimeStderrPath)}`;
	await runSandboxCommand(
		`tmux new-session -d -s ${shellEscape(runtimeSessionName)} -c ${shellEscape(sandboxWorkdir)} ${shellEscape(runtimeCommand)}`,
		{
			timeoutMs: 5000,
			user: sandboxUser,
		}
	);

	await waitForRuntimeHealth();
	console.log(
		`[synced] ${Date.now() - startedAt}ms (${installLabel} -> ${installPrefix})`
	);
}

async function syncRuntime() {
	if (syncing) {
		pendingSync = true;
		return;
	}
	syncing = true;
	stopTailing();

	try {
		await installAndRestartRuntime();
		if (!noWatch) {
			startTailing();
		}
	} catch (error) {
		console.error(
			`[sync failed] ${error instanceof Error ? error.message : String(error)}`
		);
		if (noWatch) {
			process.exit(1);
		}
	} finally {
		syncing = false;
		if (pendingSync) {
			pendingSync = false;
			triggerSync();
		}
	}
}

await syncRuntime();

if (noWatch) {
	console.log("Done (--no-watch).");
	process.exit(0);
}

console.log(
	`[watching] ${relative(repoRoot, sandboxRuntimeDir)}/ -> sandbox ${sandboxId}`
);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(sandboxRuntimeDir, { recursive: true }, (_event, filename) => {
	if (!filename) {
		return;
	}
	if (
		filename.startsWith(relative(sandboxRuntimeDir, sandboxRuntimeDistDir)) ||
		filename.startsWith("dist/") ||
		filename.startsWith(".")
	) {
		return;
	}

	if (debounceTimer) {
		clearTimeout(debounceTimer);
	}
	debounceTimer = setTimeout(() => {
		console.log(`[changed] ${filename}`);
		triggerSync();
	}, 200);
});
