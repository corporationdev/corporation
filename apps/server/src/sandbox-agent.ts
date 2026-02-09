import { env } from "cloudflare:workers";
import { createLogger } from "@corporation/logger";
import { Daytona, Image, type Sandbox } from "@daytonaio/sdk";
import { actor } from "rivetkit";
import type { UniversalEvent } from "sandbox-agent";
import {
	SandboxAgent as SandboxAgentClient,
	SandboxAgentError,
} from "sandbox-agent";

const PORT = 3000;
const SNAPSHOT_NAME = "sandbox-agent-ready";
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;

const log = createLogger("sandbox-agent");

// ---------------------------------------------------------------------------
// State & Vars types
// ---------------------------------------------------------------------------

export type SessionState = {
	sandboxId: string;
	baseUrl: string;
	sessionId: string;
	events: UniversalEvent[];
};

export type SessionVars = {
	client: SandboxAgentClient;
};

// ---------------------------------------------------------------------------
// Module-scope helpers (no actor context needed)
// ---------------------------------------------------------------------------

async function ensureSnapshot(daytona: Daytona): Promise<void> {
	let exists = true;
	try {
		await daytona.snapshot.get(SNAPSHOT_NAME);
	} catch {
		exists = false;
	}

	if (!exists) {
		log.info("creating snapshot, this may take a while");
		await daytona.snapshot.create({
			name: SNAPSHOT_NAME,
			image: Image.base("ubuntu:22.04").runCommands(
				"apt-get update && apt-get install -y curl ca-certificates",
				"curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
				"sandbox-agent install-agent claude"
			),
		});
		log.info("snapshot created");
	}
}

async function bootSandboxAgent(sandbox: Sandbox): Promise<void> {
	await sandbox.process.executeCommand(
		`nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT} >/tmp/sandbox-agent.log 2>&1 &`
	);
	await waitForServerReady(sandbox);
	log.debug({ sandboxId: sandbox.id }, "sandbox-agent server ready");
}

async function waitForServerReady(sandbox: Sandbox): Promise<void> {
	const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;

	while (Date.now() < deadline) {
		try {
			const result = await sandbox.process.executeCommand(
				`curl -sf http://localhost:${PORT}/v1/health`
			);
			if (result.exitCode === 0) {
				return;
			}
		} catch {
			// Server not ready yet
		}
		await new Promise((resolve) =>
			setTimeout(resolve, SERVER_POLL_INTERVAL_MS)
		);
	}

	throw new Error("sandbox-agent server failed to start within timeout");
}

// ---------------------------------------------------------------------------
// Actor definition
// ---------------------------------------------------------------------------

export const sandboxAgent = actor({
	// Runs once on actor creation — provisions the Daytona sandbox
	createState: async (c): Promise<SessionState> => {
		const daytona = new Daytona({ apiKey: env.DAYTONA_API_KEY });
		await ensureSnapshot(daytona);

		const sandbox = await daytona.create({
			snapshot: SNAPSHOT_NAME,
			envVars: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY },
			autoStopInterval: 0,
		});

		log.debug({ sandboxId: sandbox.id }, "sandbox created");

		await bootSandboxAgent(sandbox);

		const baseUrl = (await sandbox.getSignedPreviewUrl(PORT)).url;
		const sessionId = c.key[0] ?? crypto.randomUUID();

		log.info({ sandboxId: sandbox.id, sessionId }, "sandbox created and ready");

		return { sandboxId: sandbox.id, baseUrl, sessionId, events: [] };
	},

	// Runs on every wake (including first creation) — reconnects HTTP client
	createVars: async (c): Promise<SessionVars> => {
		const client = await SandboxAgentClient.connect({
			baseUrl: c.state.baseUrl,
		});

		// Create session — catch 409 if it already exists (reconnect case)
		try {
			await client.createSession(c.state.sessionId, { agent: "claude" });
		} catch (error) {
			if (error instanceof SandboxAgentError && error.status === 409) {
				log.debug(
					{ sessionId: c.state.sessionId },
					"session already exists, reusing"
				);
			} else {
				throw error;
			}
		}

		return { client };
	},

	// Start the SSE event stream when the actor wakes.
	// We defer with setTimeout because onWake runs before the actor is marked
	// ready, and c.waitUntil / c.broadcast require the actor to be ready.
	onWake: (c) => {
		setTimeout(() => {
			const lastSequence = c.state.events.at(-1)?.sequence ?? 0;

			log.debug(
				{ sessionId: c.state.sessionId, offset: lastSequence },
				"sse stream starting"
			);

			c.waitUntil(
				(async () => {
					try {
						for await (const event of c.vars.client.streamEvents(
							c.state.sessionId,
							{ offset: lastSequence }
						)) {
							c.state.events.push(event);
							c.broadcast("agentEvent", event);
						}
						log.debug(
							{ sessionId: c.state.sessionId },
							"sse stream ended normally"
						);
					} catch (error) {
						log.error(
							{ sessionId: c.state.sessionId, err: error },
							"sse stream error"
						);
					}
				})()
			);
		}, 0);
	},

	// Cleanup sandbox on actor destruction
	onDestroy: async (c) => {
		try {
			const daytona = new Daytona({ apiKey: env.DAYTONA_API_KEY });
			const sandbox = await daytona.get(c.state.sandboxId);
			await sandbox.delete(30);
			log.info({ sandboxId: c.state.sandboxId }, "sandbox deleted");
		} catch (error) {
			log.warn(
				{ err: error, sandboxId: c.state.sandboxId },
				"cleanup delete failed (may already be gone)"
			);
		}
	},

	options: {
		noSleep: true,
	},

	actions: {
		postMessage: async (c, content: string) => {
			await c.vars.client.postMessage(c.state.sessionId, {
				message: content,
			});
			log.info({ sessionId: c.state.sessionId }, "message sent");
		},

		replyPermission: async (
			c,
			permissionId: string,
			reply: "once" | "always" | "reject"
		) => {
			await c.vars.client.replyPermission(c.state.sessionId, permissionId, {
				reply,
			});
			log.info(
				{ sessionId: c.state.sessionId, permissionId, reply },
				"permission reply sent"
			);
		},

		// Client calls this on connect to catch up on missed events.
		// Returns events with sequence > offset (matching sandbox-agent API semantics).
		getTranscript: (c, offset: number) =>
			c.state.events.filter((e) => (e.sequence ?? 0) > offset),

		// Expose preview URL for inspector button
		getPreviewUrl: (c) => c.state.baseUrl,
	},
});
