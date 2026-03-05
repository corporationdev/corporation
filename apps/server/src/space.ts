import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Sandbox } from "e2b";
import { actor } from "rivetkit";
import { SandboxAgent as SandboxAgentClient } from "sandbox-agent";
import bundledMigrations from "./db/migrations/migrations.js";
import { type SpaceTab, schema, tabs } from "./db/schema";
import { SqliteSessionPersistDriver } from "./db/session-persist-driver";
import {
	augmentContext,
	collectDriverActions,
} from "./space/action-registration";
import { lifecycleDrivers } from "./space/driver-registry";
import {
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
const log = createLogger("space:lifecycle");
const CREATE_VARS_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 180_000;

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

		const persist = new SqliteSessionPersistDriver(db);
		const sandboxClient = await SandboxAgentClient.connect({
			baseUrl: c.state.agentUrl,
			persist,
		});
		const sandbox = await Sandbox.connect(c.state.sandboxId, {
			apiKey: env.E2B_API_KEY,
		});

		const vars: SpaceVars = {
			db,
			persist,
			sandbox,
			sandboxClient,
			terminalHandles: new Map(),
			terminalEnsures: new Map(),
			subscriptions: createSubscriptionHub(),
			lastTimeoutRefreshAt: 0,
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
		const runtime = augmentContext(c, lifecycleDrivers);
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

	options: {
		createVarsTimeout: CREATE_VARS_TIMEOUT_MS,
		actionTimeout: ACTION_TIMEOUT_MS,
	},

	onDisconnect: (c, conn) => {
		unsubscribeConnection(c.vars.subscriptions, conn.id);
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
		resetTimeout: (c) => {
			c.vars.lastTimeoutRefreshAt = 0;
			augmentContext(c, lifecycleDrivers);
		},
		...driverActions,
	},
});
