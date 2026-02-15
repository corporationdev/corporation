import { createLogger } from "@corporation/logger";
import { RivetSessionPersistDriver } from "@sandbox-agent/persist-rivet";
import { actor } from "rivetkit";

import { SandboxAgent, type Session } from "sandbox-agent";

const log = createLogger("agent");

// ---------------------------------------------------------------------------
// State & Vars types
// ---------------------------------------------------------------------------

type PersistedState = {
	slug: string;
	baseUrl: string;
};

type SessionVars = {
	sdk: SandboxAgent;
	session: Session;
	unsubscribe: () => void;
};

export const agent = actor({
	createState: (c, input: { baseUrl: string }): PersistedState => {
		const slug = c.key[0];
		if (!slug) {
			throw new Error("Actor key must contain a slug");
		}
		return {
			slug,
			baseUrl: input.baseUrl,
		};
	},

	createVars: async (c): Promise<SessionVars> => {
		const persist = new RivetSessionPersistDriver(c);
		const sdk = await SandboxAgent.connect({
			baseUrl: c.state.baseUrl,
			persist,
		});
		const session = await sdk.resumeOrCreateSession({
			id: c.state.slug,
			agent: "claude",
		});

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
