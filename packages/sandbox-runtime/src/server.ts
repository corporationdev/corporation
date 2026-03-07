/* global Bun */

import type { PromptRequestBody } from "@corporation/shared/session-protocol";
import { promptRequestBodySchema } from "@corporation/shared/session-protocol";
import { log } from "./logging";
import { getSessionBridge } from "./session-bridge";
import { stdioWrite } from "./stdio-bridge";
import { activeSessionTurns, activeTurns, executeTurn } from "./turns";

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

async function parsePromptBody(
	req: Request
): Promise<{ body: PromptRequestBody } | { errorResponse: Response }> {
	let rawBody: unknown;
	try {
		rawBody = await req.json();
	} catch {
		return {
			errorResponse: Response.json(
				{ error: "Invalid JSON body" },
				{ status: 400 }
			),
		};
	}

	const result = promptRequestBodySchema.safeParse(rawBody);
	if (!result.success) {
		return {
			errorResponse: Response.json(
				{ error: `Invalid request: ${result.error.message}` },
				{ status: 400 }
			),
		};
	}
	return { body: result.data };
}

function reserveTurn(body: PromptRequestBody): Response | null {
	if (activeTurns.has(body.turnId)) {
		return Response.json(
			{ error: "Turn already in progress" },
			{ status: 409 }
		);
	}
	if (activeSessionTurns.has(body.sessionId)) {
		return Response.json(
			{ error: "Session already has an active turn" },
			{ status: 409 }
		);
	}

	const existingBridge = getSessionBridge(body.sessionId);
	if (existingBridge?.activeTurnId) {
		return Response.json(
			{ error: "Session already has an active turn" },
			{ status: 409 }
		);
	}

	activeTurns.set(body.turnId, body.sessionId);
	activeSessionTurns.set(body.sessionId, body.turnId);
	if (existingBridge) {
		existingBridge.activeTurnId = body.turnId;
	}

	return null;
}

async function handlePromptRequest(req: Request): Promise<Response> {
	const parsed = await parsePromptBody(req);
	if ("errorResponse" in parsed) {
		return parsed.errorResponse;
	}

	const { body } = parsed;
	const reservationError = reserveTurn(body);
	if (reservationError) {
		return reservationError;
	}

	executeTurn(body).catch((error) => {
		log("error", "Unhandled turn error", {
			turnId: body.turnId,
			error: error instanceof Error ? error.message : String(error),
		});
	});

	return Response.json({ accepted: true }, { status: 202 });
}

function handleTurnCancel(pathname: string): Response {
	const turnId = pathname.slice("/v1/prompt/".length);
	const sessionId = activeTurns.get(turnId);
	if (sessionId === undefined) {
		return Response.json({ error: "Turn not found" }, { status: 404 });
	}

	const sessionBridge = getSessionBridge(sessionId);
	if (sessionBridge) {
		// Send ACP session/cancel notification — the agent will finish
		// the in-flight session/prompt with a "cancelled" stop reason,
		// preserving the bridge and its history for the next turn.
		const cancelEnvelope: Record<string, unknown> = {
			jsonrpc: "2.0",
			method: "session/cancel",
			params: { sessionId: sessionBridge.agentSessionId },
		};
		stdioWrite(sessionBridge.bridge, cancelEnvelope);
		log("info", "Sent session/cancel to agent", { turnId, sessionId });
	}

	return Response.json({ cancelled: true });
}

function handleRequest(req: Request): Response | Promise<Response> {
	const url = new URL(req.url);
	// TODO(auth): Require authentication for sandbox-runtime HTTP routes
	// (at minimum `/v1/prompt` and `/v1/prompt/:turnId`).

	if (req.method === "GET" && url.pathname === "/v1/health") {
		return Response.json({ status: "ok" });
	}
	if (req.method === "POST" && url.pathname === "/v1/prompt") {
		return handlePromptRequest(req);
	}
	if (req.method === "DELETE" && url.pathname.startsWith("/v1/prompt/")) {
		return handleTurnCancel(url.pathname);
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}

Bun.serve({
	hostname: host,
	port,
	fetch: handleRequest,
});

log("info", `Listening on ${host}:${port}`);
console.log(`[sandbox-runtime] Listening on ${host}:${port}`);
