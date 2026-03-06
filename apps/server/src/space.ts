import { env } from "@corporation/env/server";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Sandbox } from "e2b";
import { actor } from "rivetkit";
import bundledMigrations from "./db/migrations/migrations.js";
import { type SpaceTab, schema, tabs } from "./db/schema";
import {
	collectDriverActions,
	refreshSandboxTimeout,
} from "./space/action-registration";
import { lifecycleDrivers } from "./space/driver-registry";
import {
	createSubscriptionHub,
	unsubscribeConnection,
} from "./space/subscriptions";
import { broadcastTabsChanged, listSpaceTabs } from "./space/tab-list";
import type { PersistedState, SpaceVars } from "./space/types";

export type { SessionTab, SpaceTab, TabType, TerminalTab } from "./db/schema";

const driverActions = collectDriverActions(lifecycleDrivers);

export const space = actor({
	createState: (
		c,
		input: {
			agentUrl: string;
			sandboxId: string;
			workdir: string;
		}
	): PersistedState => {
		const spaceSlug = c.key[0];
		if (!spaceSlug) {
			throw new Error("Actor key must contain a spaceSlug");
		}

		return {
			agentUrl: input.agentUrl,
			sandboxId: input.sandboxId,
			workdir: input.workdir,
		};
	},

	createVars: async (c, driverCtx: DriverContext): Promise<SpaceVars> => {
		const db = drizzle(driverCtx.state.storage, { schema });

		await migrate(db, bundledMigrations);

		if (!env.E2B_API_KEY) {
			throw new Error("Missing E2B_API_KEY env var");
		}

		const sandbox = await Sandbox.connect(c.state.sandboxId, {
			apiKey: env.E2B_API_KEY,
		});

		const vars: SpaceVars = {
			db,
			sandbox,
			terminalHandles: new Map(),
			terminalEnsures: new Map(),
			terminalOpenActions: new Map(),
			lastTerminalSnapshotAt: new Map(),
			subscriptions: createSubscriptionHub(),
			lastTimeoutRefreshAt: 0,
			agentRunnerSequenceBySessionId: new Map(),
		};

		return vars;
	},

	onBeforeActionResponse: (c, _name, _args, output) => {
		refreshSandboxTimeout(c);
		return output;
	},

	onWake: async (c) => {
		refreshSandboxTimeout(c);
		for (const driver of lifecycleDrivers) {
			await driver.onWake?.(c);
		}
	},

	onDisconnect: (c, conn) => {
		unsubscribeConnection(c.vars.subscriptions, conn.id);
		const prefix = `${conn.id}:`;
		for (const key of c.vars.terminalOpenActions.keys()) {
			if (key.startsWith(prefix)) {
				c.vars.terminalOpenActions.delete(key);
			}
		}
		for (const key of c.vars.lastTerminalSnapshotAt.keys()) {
			if (key.startsWith(prefix)) {
				c.vars.lastTerminalSnapshotAt.delete(key);
			}
		}
	},

	actions: {
		listTabs: async (c): Promise<SpaceTab[]> => {
			const allTabs = await listSpaceTabs(c);
			allTabs.sort((left, right) => {
				if (left.updatedAt !== right.updatedAt) {
					return right.updatedAt - left.updatedAt;
				}
				return left.createdAt - right.createdAt;
			});

			return allTabs;
		},
		closeTab: async (c, tabId: string) => {
			await c.vars.db
				.update(tabs)
				.set({ active: false, updatedAt: Date.now() })
				.where(eq(tabs.id, tabId));
			await broadcastTabsChanged(c);
		},
		archiveTab: async (c, tabId: string) => {
			await c.vars.db
				.update(tabs)
				.set({ active: false, archivedAt: Date.now(), updatedAt: Date.now() })
				.where(eq(tabs.id, tabId));
			await broadcastTabsChanged(c);
		},
		resetTimeout: (c) => {
			c.vars.lastTimeoutRefreshAt = 0;
		},
		...driverActions,
	},
});
