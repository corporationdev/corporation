/* global Bun */

import { AgentRuntime } from "./agent-runtime";
import { createApp } from "./app";
import { log } from "./logging";

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 5799;
const DEFAULT_HOST = "0.0.0.0";

function parseArgs(): { host: string; port: number } {
	const args = process.argv.slice(2);
	let host = DEFAULT_HOST;
	let port = DEFAULT_PORT;

	for (let i = 0; i < args.length; i++) {
		const next = args[i + 1];
		if (args[i] === "--host" && next) {
			host = next;
			i++;
		} else if (args[i] === "--port" && next) {
			port = Number.parseInt(next, 10);
			i++;
		}
	}

	return { host, port };
}

const { host, port } = parseArgs();

const runtime = new AgentRuntime();
const app = createApp(runtime);

Bun.serve({
	hostname: host,
	port,
	fetch: app.fetch,
});

log("info", `Listening on ${host}:${port}`);
console.log(`[sandbox-runtime] Listening on ${host}:${port}`);
