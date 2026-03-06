import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Sandbox } from "e2b";
import { actor } from "rivetkit";
import bundledMigrations from "./db/migrations/migrations.js";
import { type SpaceTab, schema, tabs } from "./db/schema";
import {
	augmentContext,
	collectDriverActions,
} from "./space/action-registration";
import { lifecycleDrivers } from "./space/driver-registry";
import {
	createSubscriptionHub,
	unsubscribeConnection,
} from "./space/subscriptions";
import { listSpaceTabs } from "./space/tab-list";
import type { PersistedState, SpaceVars } from "./space/types";

export type { SessionTab, SpaceTab, TabType, TerminalTab } from "./db/schema";

const driverActions = collectDriverActions(lifecycleDrivers);
const log = createLogger("space:lifecycle");

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
		const startedAt = Date.now();
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

		log.info(
			{
				actorKey: c.key.join("/"),
				durationMs: Date.now() - startedAt,
			},
			"space.create-vars.ok"
		);
		return vars;
	},

	onWake: async (c) => {
		const startedAt = Date.now();
		const runtime = augmentContext(c);
		try {
			for (const driver of lifecycleDrivers) {
				await driver.onWake?.(runtime);
			}

			log.info(
				{
					actorId: runtime.actorId,
					durationMs: Date.now() - startedAt,
				},
				"space.on-wake.ok"
			);
		} catch (error) {
			log.error(
				{
					actorId: runtime.actorId,
					durationMs: Date.now() - startedAt,
					err: error,
				},
				"space.on-wake.failed"
			);
			throw error;
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
			const ctx = augmentContext(c);
			const allTabs = await listSpaceTabs(ctx);
			allTabs.sort((left, right) => {
				if (left.updatedAt !== right.updatedAt) {
					return right.updatedAt - left.updatedAt;
				}
				return left.createdAt - right.createdAt;
			});

			return allTabs;
		},
		closeTab: async (c, tabId: string) => {
			const ctx = augmentContext(c);
			await ctx.vars.db
				.update(tabs)
				.set({ active: false, updatedAt: Date.now() })
				.where(eq(tabs.id, tabId));
			await ctx.broadcastTabsChanged();
		},
		archiveTab: async (c, tabId: string) => {
			const ctx = augmentContext(c);
			await ctx.vars.db
				.update(tabs)
				.set({ active: false, archivedAt: Date.now(), updatedAt: Date.now() })
				.where(eq(tabs.id, tabId));
			await ctx.broadcastTabsChanged();
		},
		resetTimeout: (c) => {
			c.vars.lastTimeoutRefreshAt = 0;
			augmentContext(c);
		},
		...driverActions,
	},
});
