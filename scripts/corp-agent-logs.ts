#!/usr/bin/env bun

/**
 * Tail corp-agent logs from a running E2B sandbox.
 *
 * Usage:
 *   bun scripts/corp-agent-logs.ts <sandbox-id> [--follow]
 */

import { resolve } from "node:path";
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

const sandboxId = process.argv[2];
const follow = process.argv.includes("--follow") || process.argv.includes("-f");

if (!sandboxId) {
	console.error(
		"Usage: bun scripts/corp-agent-logs.ts <sandbox-id> [--follow]"
	);
	process.exit(1);
}

const sandbox = await Sandbox.connect(sandboxId);

if (follow) {
	// Tail -f: poll every second for new content
	let offset = 0;
	const poll = async () => {
		try {
			const result = await sandbox.commands.run(
				"wc -c < /tmp/corp-agent.log 2>/dev/null || echo 0"
			);
			const size = Number.parseInt(result.stdout.trim(), 10);
			if (size > offset) {
				const chunk = await sandbox.commands.run(
					`tail -c +${offset + 1} /tmp/corp-agent.log`
				);
				process.stdout.write(chunk.stdout);
				offset = size;
			}
		} catch {
			// File might not exist yet
		}
	};

	console.error(`[tailing /tmp/corp-agent.log on sandbox ${sandboxId}...]`);
	// biome-ignore lint: using setInterval intentionally
	setInterval(poll, 1000);
	await poll();
} else {
	// One-shot: dump the log file then truncate it
	try {
		const result = await sandbox.commands.run(
			"cat /tmp/corp-agent.log && : > /tmp/corp-agent.log"
		);
		process.stdout.write(result.stdout);
		if (result.stderr.trim()) {
			process.stderr.write(result.stderr);
		}
	} catch (error) {
		console.error(
			"Failed to read logs:",
			error instanceof Error ? error.message : String(error)
		);
		process.exit(1);
	}
}
