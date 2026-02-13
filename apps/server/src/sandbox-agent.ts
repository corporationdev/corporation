import { createLogger } from "@corporation/logger";
import { actor } from "rivetkit";
import type { UniversalEvent } from "sandbox-agent";
import {
	SandboxAgent as SandboxAgentClient,
	SandboxAgentError,
} from "sandbox-agent";

const log = createLogger("sandbox-agent");

// ---------------------------------------------------------------------------
// State & Vars types
// ---------------------------------------------------------------------------

export type SessionState = {
	baseUrl: string;
	sessionId: string;
	events: UniversalEvent[];
};

export type SessionVars = {
	client: SandboxAgentClient;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureSessionExists(
	client: SandboxAgentClient,
	sessionId: string
): Promise<void> {
	try {
		await client.createSession(sessionId, { agent: "claude" });
	} catch (error) {
		if (error instanceof SandboxAgentError && error.status === 409) {
			log.debug({ sessionId }, "session already exists, reusing");
			return;
		}
		throw error;
	}
}

async function connectClient(
	baseUrl: string,
	sessionId: string
): Promise<SandboxAgentClient> {
	const client = await SandboxAgentClient.connect({ baseUrl });
	await ensureSessionExists(client, sessionId);
	return client;
}

// ---------------------------------------------------------------------------
// Actor definition
// ---------------------------------------------------------------------------

export const sandboxAgent = actor({
	createState: (c, input: { baseUrl: string }): SessionState => {
		const sessionId = c.key[0];
		if (!sessionId) {
			throw new Error("Actor key must contain a threadId");
		}

		log.info({ sessionId, baseUrl: input.baseUrl }, "actor created");

		return { baseUrl: input.baseUrl, sessionId, events: [] };
	},

	createVars: async (c): Promise<SessionVars> => {
		const client = await connectClient(c.state.baseUrl, c.state.sessionId);
		return { client };
	},

	// Start the SSE event stream when the actor wakes.
	// Deferred with setTimeout because onWake runs before the actor is marked
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

	actions: {
		postMessage: async (c, content: string, baseUrl?: string) => {
			if (baseUrl && baseUrl !== c.state.baseUrl) {
				log.info({ sessionId: c.state.sessionId }, "updating baseUrl");
				c.state.baseUrl = baseUrl;
				c.vars.client = await connectClient(baseUrl, c.state.sessionId);
			}

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

		getPreviewUrl: (c) => c.state.baseUrl,
	},
});
