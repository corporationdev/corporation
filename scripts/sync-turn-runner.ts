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

const localRunnerDir = resolve(repoRoot, "scripts/turn-runner");
const remoteRunnerDir = "/opt/corporation/turn-runner";
const filesToSync = [
	"README.md",
	"corp-turn-runner.mjs",
	"package.json",
] as const;

const argv = process.argv.slice(2);

const namedSandboxIdIndex = argv.indexOf("--sandbox-id");
const namedSandboxId =
	namedSandboxIdIndex >= 0 ? argv[namedSandboxIdIndex + 1] : undefined;
const positionalSandboxId = argv.find((arg) => !arg.startsWith("--"));
const sandboxId = namedSandboxId ?? positionalSandboxId;

if (!sandboxId) {
	console.error(
		[
			"Missing sandbox id.",
			"Usage:",
			"  bun scripts/sync-turn-runner.ts <sandbox-id>",
			"  bun scripts/sync-turn-runner.ts --sandbox-id <sandbox-id>",
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

console.log(`Syncing turn-runner to sandbox ${sandboxId}...`);

try {
	const sandbox = await Sandbox.connect(sandboxId);
	await sandbox.files.makeDir(remoteRunnerDir);

	const writeEntries = await Promise.all(
		filesToSync.map(async (fileName) => ({
			path: `${remoteRunnerDir}/${fileName}`,
			data: await readFile(resolve(localRunnerDir, fileName), "utf8"),
		}))
	);
	await sandbox.files.write(writeEntries);

	const installCmd = [
		"set -euo pipefail",
		`cd ${remoteRunnerDir}`,
		"npm install --omit=dev --no-audit --no-fund",
		"chmod +x corp-turn-runner.mjs",
		"ln -sf /opt/corporation/turn-runner/corp-turn-runner.mjs /usr/local/bin/corp-turn-runner",
		"node --check /opt/corporation/turn-runner/corp-turn-runner.mjs",
	].join("; ");

	await sandbox.commands.run(installCmd, { timeoutMs: 5 * 60_000 });

	console.log("Turn-runner sync complete.");
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Turn-runner sync failed: ${message}`);
	process.exit(1);
}
