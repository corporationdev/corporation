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

const localBinaryPath = resolve(repoRoot, "scripts/corp-agent/dist/corp-agent");
const remoteBinaryPath = "/usr/local/bin/corp-agent";

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
			"  bun scripts/sync-corp-agent.ts <sandbox-id>",
			"  bun scripts/sync-corp-agent.ts --sandbox-id <sandbox-id>",
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

console.log(`Syncing corp-agent to sandbox ${sandboxId}...`);

try {
	const sandbox = await Sandbox.connect(sandboxId);
	const binaryData = await readFile(localBinaryPath);

	await sandbox.files.write([
		{
			path: remoteBinaryPath,
			data: binaryData,
		},
	]);

	await sandbox.commands.run(`chmod +x ${remoteBinaryPath}`, {
		timeoutMs: 5000,
	});

	// Restart the corp-agent tmux session
	await sandbox.commands.run(
		"tmux kill-session -t sandbox-agent 2>/dev/null || true",
		{ timeoutMs: 5000 }
	);
	await sandbox.commands.run(
		'tmux new-session -d -s sandbox-agent "corp-agent --host 0.0.0.0 --port 5799"',
		{ timeoutMs: 5000 }
	);

	console.log("Corp-agent sync complete.");
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Corp-agent sync failed: ${message}`);
	process.exit(1);
}
