import { env } from "@corporation/env/server";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { RivetSessionPersistDriver } from "@sandbox-agent/persist-rivet";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Sandbox } from "e2b";
import { actor } from "rivetkit";
import { SandboxAgent as SandboxAgentClient } from "sandbox-agent";
import bundledMigrations from "./db/migrations/migrations.js";
import { previews, type SpaceTab, tabs, terminals } from "./db/schema";
import {
	augmentContext,
	collectDriverActions,
} from "./space/action-registration";
import { lifecycleDrivers } from "./space/driver-registry";
import {
	clearSubscriptions,
	createSubscriptionHub,
	unsubscribeConnection,
} from "./space/subscriptions";
import type { PersistedState, SpaceVars } from "./space/types";

export type {
	PreviewTab,
	SessionTab,
	SpaceTab,
	TabType,
	TerminalTab,
} from "./db/schema";

const driverActions = collectDriverActions(lifecycleDrivers);

export const space = actor({
	createState: (
		c,
		input: {
			sandboxUrl: string;
			sandboxId: string;
			workdir: string;
		}
	): PersistedState => {
		const spaceSlug = c.key[0];
		if (!spaceSlug) {
			throw new Error("Actor key must contain a spaceSlug");
		}

		return {
			sandboxUrl: input.sandboxUrl,
			sandboxId: input.sandboxId,
			workdir: input.workdir,
			_sandboxAgentPersist: { sessions: {}, events: {} },
		};
	},

	createVars: async (c, driverCtx: DriverContext): Promise<SpaceVars> => {
		const db = drizzle(driverCtx.state.storage, {
			schema: {
				tabs,
				terminals,
				previews,
			},
		});

		await migrate(db, bundledMigrations);

		if (!env.E2B_API_KEY) {
			throw new Error("Missing E2B_API_KEY env var");
		}

		const persist = new RivetSessionPersistDriver(c);
		const sandboxClient = await SandboxAgentClient.connect({
			baseUrl: c.state.sandboxUrl,
			persist,
		});
		const sandbox = await Sandbox.connect(c.state.sandboxId, {
			apiKey: env.E2B_API_KEY,
		});

		return {
			db,
			sandbox,
			sandboxClient,
			sessionStreams: new Map(),
			terminalHandles: new Map(),
			terminalBuffers: new Map(),
			terminalPersistWrites: new Map(),
			subscriptions: createSubscriptionHub(),
		};
	},

	onDisconnect: (c, conn) => {
		unsubscribeConnection(c.vars.subscriptions, conn.id);
	},

	onSleep: async (c) => {
		const ctx = augmentContext(c, lifecycleDrivers);
		for (const driver of lifecycleDrivers) {
			await driver.onSleep(ctx);
		}
		clearSubscriptions(c.vars.subscriptions);
	},

	actions: {
		listTabs: async (c): Promise<SpaceTab[]> => {
			const ctx = augmentContext(c, lifecycleDrivers);
			const allTabs = (
				await Promise.all(
					lifecycleDrivers.map((driver) => driver.listTabs(ctx))
				)
			).flat();

			allTabs.sort((left, right) => {
				if (left.updatedAt !== right.updatedAt) {
					return right.updatedAt - left.updatedAt;
				}
				return left.createdAt - right.createdAt;
			});

			return allTabs;
		},
		closeTab: async (c, tabId: string) => {
			const ctx = augmentContext(c, lifecycleDrivers);
			await ctx.vars.db
				.update(tabs)
				.set({ active: false, updatedAt: Date.now() })
				.where(eq(tabs.id, tabId));
			await ctx.broadcastTabsChanged();
		},
		archiveTab: async (c, tabId: string) => {
			const ctx = augmentContext(c, lifecycleDrivers);
			await ctx.vars.db
				.update(tabs)
				.set({ active: false, archivedAt: Date.now(), updatedAt: Date.now() })
				.where(eq(tabs.id, tabId));
			await ctx.broadcastTabsChanged();
		},
		...driverActions,
	},
});
