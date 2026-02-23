import { createLogger } from "@corporation/logger";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { UniversalEvent } from "sandbox-agent";
import {
	SandboxAgent as SandboxAgentClient,
	SandboxAgentError,
} from "sandbox-agent";
import { type SessionTab, sessionEvents, sessions, tabs } from "../db/schema";
import { createTabChannel, createTabId } from "./channels";
import type { SandboxContextUpdate, TabDriverLifecycle } from "./driver-types";
import { publishToChannel } from "./subscriptions";
import type { SpaceRuntimeContext } from "./types";

const log = createLogger("space:session");
const DEFAULT_SESSION_TITLE = "New Chat";
const SESSION_EVENT_NAME = "session.event";

function abortAllSessionStreams(ctx: SpaceRuntimeContext): void {
	for (const abortController of ctx.vars.sessionStreams.values()) {
		abortController.abort();
	}
	ctx.vars.sessionStreams.clear();
}

async function applySandboxUrlUpdate(
	ctx: SpaceRuntimeContext,
	sandboxUrl?: string | null
): Promise<void> {
	if (sandboxUrl === undefined || sandboxUrl === ctx.state.sandboxUrl) {
		return;
	}

	ctx.state.sandboxUrl = sandboxUrl;
	ctx.vars.sandboxClient = sandboxUrl
		? await SandboxAgentClient.connect({ baseUrl: sandboxUrl })
		: null;
	abortAllSessionStreams(ctx);
}

async function ensureSandboxClient(
	ctx: SpaceRuntimeContext
): Promise<SandboxAgentClient> {
	if (!ctx.vars.sandboxClient) {
		if (!ctx.state.sandboxUrl) {
			throw new Error("Sandbox is not ready for session operations");
		}
		ctx.vars.sandboxClient = await SandboxAgentClient.connect({
			baseUrl: ctx.state.sandboxUrl,
		});
	}

	const sandboxClient = ctx.vars.sandboxClient;
	if (!sandboxClient) {
		throw new Error("Sandbox is not ready for session operations");
	}

	return sandboxClient;
}

async function ensureRemoteSessionExists(
	client: SandboxAgentClient,
	sessionId: string
): Promise<void> {
	try {
		await client.createSession(sessionId, { agent: "claude" });
	} catch (error) {
		if (error instanceof SandboxAgentError && error.status === 409) {
			return;
		}
		throw error;
	}
}

async function persistSessionEvent(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	event: UniversalEvent
): Promise<void> {
	const sequence = event.sequence ?? 0;
	if (sequence <= 0) {
		return;
	}

	await ctx.vars.db
		.insert(sessionEvents)
		.values({
			sessionId,
			sequence,
			eventJson: JSON.stringify(event),
			createdAt: Date.now(),
		})
		.onConflictDoNothing();

	publishToChannel(
		ctx,
		createTabChannel("session", sessionId),
		SESSION_EVENT_NAME,
		event
	);
}

// TODO: Revisit stream lifecycle on reconnect/DO eviction.
// Streams are currently started from message-send flow; subscribe only manages
// channel membership. Decide on a robust resume strategy before changing this.
async function ensureStreamRunning(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	sandboxClient: SandboxAgentClient
): Promise<void> {
	if (ctx.vars.sessionStreams.has(sessionId)) {
		return;
	}

	const lastSequenceRows = await ctx.vars.db
		.select({
			lastSequence: sql<number>`coalesce(max(${sessionEvents.sequence}), 0)`,
		})
		.from(sessionEvents)
		.where(eq(sessionEvents.sessionId, sessionId));

	const lastSequence = lastSequenceRows[0]?.lastSequence ?? 0;
	const abortController = new AbortController();
	ctx.vars.sessionStreams.set(sessionId, abortController);

	ctx.waitUntil(
		(async () => {
			try {
				for await (const event of sandboxClient.streamEvents(
					sessionId,
					{ offset: lastSequence },
					abortController.signal
				)) {
					await persistSessionEvent(ctx, sessionId, event);
				}
			} catch (error) {
				if (!abortController.signal.aborted) {
					log.error({ sessionId, err: error }, "session stream failed");
				}
			} finally {
				ctx.vars.sessionStreams.delete(sessionId);
			}
		})()
	);
}

async function ensureSession(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	title?: string
): Promise<void> {
	const now = Date.now();
	const tabId = createTabId("session", sessionId);
	const nextTitle = title ?? DEFAULT_SESSION_TITLE;

	await ctx.vars.db.transaction(async (tx) => {
		const existing = await tx
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);

		if (existing.length === 0) {
			await tx.insert(tabs).values({
				id: tabId,
				type: "session",
				title: nextTitle,
				createdAt: now,
				updatedAt: now,
				archivedAt: null,
			});

			await tx.insert(sessions).values({
				id: sessionId,
				tabId,
				status: "waiting",
				createdAt: now,
				updatedAt: now,
			});
			return;
		}

		if (title) {
			await tx
				.update(tabs)
				.set({ title, updatedAt: now })
				.where(eq(tabs.id, tabId));
		}
	});

	await ctx.broadcastTabsChanged();
}

async function postMessage(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	content: string,
	sandboxUrl?: string
): Promise<void> {
	await applySandboxUrlUpdate(ctx, sandboxUrl);

	const sandboxClient = await ensureSandboxClient(ctx);
	await ensureRemoteSessionExists(sandboxClient, sessionId);
	await ensureStreamRunning(ctx, sessionId, sandboxClient);

	await sandboxClient.postMessage(sessionId, {
		message: content,
	});

	await ctx.vars.db
		.update(sessions)
		.set({ status: "running", updatedAt: Date.now() })
		.where(eq(sessions.id, sessionId));

	await ctx.vars.db
		.update(tabs)
		.set({ updatedAt: Date.now() })
		.where(eq(tabs.id, createTabId("session", sessionId)));

	await ctx.broadcastTabsChanged();
}

async function replyPermission(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	permissionId: string,
	reply: "once" | "always" | "reject"
): Promise<void> {
	const sandboxClient = await ensureSandboxClient(ctx);
	await sandboxClient.replyPermission(sessionId, permissionId, {
		reply,
	});
}

async function getTranscript(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	offset: number,
	limit?: number
): Promise<UniversalEvent[]> {
	const baseQuery = ctx.vars.db
		.select({ eventJson: sessionEvents.eventJson })
		.from(sessionEvents)
		.where(
			and(
				eq(sessionEvents.sessionId, sessionId),
				gt(sessionEvents.sequence, offset)
			)
		)
		.orderBy(asc(sessionEvents.sequence));

	const rows =
		limit === undefined ? await baseQuery : await baseQuery.limit(limit);

	return rows.map((row) => JSON.parse(row.eventJson) as UniversalEvent);
}

async function listTabs(ctx: SpaceRuntimeContext): Promise<SessionTab[]> {
	const rows = await ctx.vars.db
		.select({
			tabId: tabs.id,
			type: tabs.type,
			title: tabs.title,
			createdAt: tabs.createdAt,
			updatedAt: tabs.updatedAt,
			archivedAt: tabs.archivedAt,
			sessionId: sessions.id,
			sessionStatus: sessions.status,
		})
		.from(tabs)
		.innerJoin(sessions, eq(tabs.id, sessions.tabId))
		.where(and(eq(tabs.type, "session"), isNull(tabs.archivedAt)))
		.orderBy(desc(tabs.updatedAt), asc(tabs.createdAt));

	return rows.map((row) => {
		const tab: SessionTab = {
			id: row.tabId,
			type: "session",
			title: row.title,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			archivedAt: row.archivedAt,
			sessionId: row.sessionId,
			status: row.sessionStatus,
		};
		return tab;
	});
}

function onSleep(ctx: SpaceRuntimeContext): Promise<void> {
	abortAllSessionStreams(ctx);
	return Promise.resolve();
}

async function onSandboxContextChanged(
	ctx: SpaceRuntimeContext,
	update: SandboxContextUpdate
): Promise<void> {
	await applySandboxUrlUpdate(ctx, update.sandboxUrl);
}

type SessionPublicActions = {
	ensureSession: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		title?: string
	) => Promise<void>;
	postMessage: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		content: string,
		sandboxUrl?: string
	) => Promise<void>;
	replyPermission: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		permissionId: string,
		reply: "once" | "always" | "reject"
	) => Promise<void>;
	getTranscript: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		offset: number,
		limit?: number
	) => Promise<UniversalEvent[]>;
};

type SessionDriver = TabDriverLifecycle<SessionPublicActions> & {
	publicActions: SessionPublicActions;
};

export const sessionDriver: SessionDriver = {
	kind: "session",
	onSleep,
	onSandboxContextChanged,
	listTabs,
	publicActions: {
		ensureSession,
		postMessage,
		replyPermission,
		getTranscript,
	},
};
