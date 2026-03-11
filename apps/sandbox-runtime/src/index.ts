#!/usr/bin/env bun
/* global Bun */

/**
 * sandbox-runtime — compiled Bun binary that runs inside E2B sandboxes.
 *
 * Responsibilities:
 *   1. HTTP server on a configurable port (default 5799)
 *      - GET  /v1/health
 *      - POST /v1/prompt
 *      - DELETE /v1/prompt/:turnId
 *   2. ACP JSON-RPC bridge: spawns an agent subprocess and communicates
 *      via stdin/stdout using newline-delimited JSON (ndjson).
 *   3. Streams session events back to the actor via ordered HTTP callbacks.
 */

// ---------------------------------------------------------------------------
// Subcommand routing: `sandbox-runtime mcp <name>` starts an MCP server
// ---------------------------------------------------------------------------

const subcommand = process.argv[2];
if (subcommand === "mcp") {
	const mcpName = process.argv[3];
	if (mcpName === "desktop") {
		const { runDesktopMcp } = await import("./desktop-mcp");
		await runDesktopMcp();
		// Keep the process alive — StdioServerTransport reads from stdin
		// but server.connect() returns immediately. Block here so we don't
		// fall through to the HTTP server code below.
		// biome-ignore lint/suspicious/noEmptyBlockStatements: intentionally block forever
		await new Promise(() => {});
	} else if (mcpName === "code") {
		const { runCodeMcp } = await import("./code-mcp");
		await runCodeMcp();
		// Keep the process alive — StdioServerTransport reads from stdin
		// but server.connect() returns immediately. Block here so we don't
		// fall through to the HTTP server code below.
		// biome-ignore lint/suspicious/noEmptyBlockStatements: intentionally block forever
		await new Promise(() => {});
	} else {
		console.error(`Unknown MCP server: ${mcpName}`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Default mode: start HTTP server
// ---------------------------------------------------------------------------

await import("./server");

export {};
