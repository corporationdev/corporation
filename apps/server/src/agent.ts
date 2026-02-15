import { RivetSessionPersistDriver } from "@sandbox-agent/persist-rivet";
import { actor } from "rivetkit";

import { SandboxAgent, type Session } from "sandbox-agent";

// ---------------------------------------------------------------------------
// State & Vars types
// ---------------------------------------------------------------------------

type PersistedState = {
	slug: string;
	sandboxUrl: string;
};

type SessionVars = {
	sdk: SandboxAgent;
	session: Session;
	unsubscribe: () => void;
};

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 500;

async function waitForHealth(sdk: SandboxAgent) {
	const start = Date.now();
	while (Date.now() - start < HEALTH_TIMEOUT_MS) {
		try {
			await sdk.getHealth();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
		}
	}
	throw new Error("Timed out waiting for sandbox-agent to become healthy");
}

export const agent = actor({
	createState: (c, input: { sandboxUrl: string }): PersistedState => {
		const slug = c.key[0];
		if (!slug) {
			throw new Error("Actor key must contain a slug");
		}
		return {
			slug,
			sandboxUrl: input.sandboxUrl,
		};
	},

	createVars: async (c): Promise<SessionVars> => {
		const persist = new RivetSessionPersistDriver(c);
		console.log("[agent] connecting to sandbox-agent at", c.state.sandboxUrl);

		const sdk = await SandboxAgent.connect({
			baseUrl: c.state.sandboxUrl,
			persist,
		});
		console.log("[agent] connected, waiting for health...");

		await waitForHealth(sdk);
		console.log("[agent] healthy, installing claude agent...");

		await sdk.installAgent("claude");
		console.log("[agent] claude installed, creating session...");

		const agents = await sdk.listAgents({ config: true });
		console.log("[agent] available agents:", JSON.stringify(agents));

		const session = await sdk.resumeOrCreateSession({
			id: c.state.slug,
			agent: "claude",
		});
		console.log("[agent] session created successfully");

		const unsubscribe = session.onEvent((event) => {
			c.broadcast("session.event", event);
		});

		return { sdk, session, unsubscribe };
	},

	actions: {
		sendMessage: async (c, message: string) => {
			await c.vars.session.prompt([{ type: "text", text: message }]);
		},

		getEvents: (c, cursor?: string, limit?: number) => {
			return c.vars.sdk.getEvents({
				sessionId: c.state.slug,
				cursor,
				limit,
			});
		},

		replyPermission: async (
			c,
			permissionId: string,
			reply: "once" | "always" | "reject"
		) => {
			await c.vars.session.send("session/permission/reply", {
				permission_id: permissionId,
				reply,
			});
		},
	},
	onSleep: async (c) => {
		c.vars.unsubscribe?.();
		await c.vars.sdk.dispose();
	},
});
