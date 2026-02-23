import { env } from "@corporation/env/server";
import { Daytona } from "@daytonaio/sdk";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { actor } from "rivetkit";
import { SandboxAgent as SandboxAgentClient } from "sandbox-agent";
import bundledMigrations from "./db/migrations/migrations.js";
import {
	type SpaceTab,
	sessionEvents,
	sessions,
	tabs,
	terminals,
} from "./db/schema";
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
	SessionStatus,
	SessionTab,
	SpaceTab,
	TabType,
	TerminalTab,
} from "./db/schema";

const driverActions = collectDriverActions(lifecycleDrivers);

export const space = actor({
	createState: (
		c,
		input?: {
			sandboxUrl?: string;
			sandboxId?: string;
		}
	): PersistedState => {
		const spaceSlug = c.key[0];
		if (!spaceSlug) {
			throw new Error("Actor key must contain a spaceSlug");
		}

		return {
			sandboxUrl: input?.sandboxUrl ?? null,
			sandboxId: input?.sandboxId ?? null,
		};
	},

	createVars: async (c, driverCtx: DriverContext): Promise<SpaceVars> => {
		const db = drizzle(driverCtx.state.storage, {
			schema: {
				tabs,
				sessions,
				sessionEvents,
				terminals,
			},
		});

		await migrate(db, bundledMigrations);

		const sandboxClient = c.state.sandboxUrl
			? await SandboxAgentClient.connect({ baseUrl: c.state.sandboxUrl })
			: null;

		return {
			db,
			daytona: new Daytona({ apiKey: env.DAYTONA_API_KEY }),
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
		for (const driver of lifecycleDrivers) {
			await driver.onSleep(c);
		}
		clearSubscriptions(c.vars.subscriptions);
	},

	actions: {
		setSandboxContext: async (
			c,
			sandboxId: string | null,
			sandboxUrl?: string | null
		) => {
			for (const driver of lifecycleDrivers) {
				await driver.onSandboxContextChanged(c, { sandboxId, sandboxUrl });
			}
		},

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
		archiveTab: async (c, tabId: string) => {
			const ctx = augmentContext(c, lifecycleDrivers);
			await ctx.vars.db
				.update(tabs)
				.set({ archivedAt: Date.now(), updatedAt: Date.now() })
				.where(eq(tabs.id, tabId));
			await ctx.broadcastTabsChanged();
		},
		...driverActions,
	},
});
