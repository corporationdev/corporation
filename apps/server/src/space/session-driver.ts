import { RivetSessionPersistDriver } from "@sandbox-agent/persist-rivet";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Session, SessionEvent } from "sandbox-agent";
import { type SessionTab, tabs } from "../db/schema";
import { createTabChannel, createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import { publishToChannel } from "./subscriptions";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_SESSION_TITLE = "New Chat";
const DEFAULT_AGENT = "opencode";
const SESSION_EVENT_NAME = "session.event";

function abortAllSessionStreams(ctx: SpaceRuntimeContext): void {
	for (const unsubscribe of ctx.vars.sessionStreams.values()) {
		unsubscribe();
	}
	ctx.vars.sessionStreams.clear();
}

function ensureEventListener(ctx: SpaceRuntimeContext, session: Session): void {
	const sessionId = session.id;
	if (ctx.vars.sessionStreams.has(sessionId)) {
		return;
	}

	const unsubscribe = session.onEvent((event) => {
		publishToChannel(
			ctx,
			createTabChannel("session", sessionId),
			SESSION_EVENT_NAME,
			event
		);
	});

	ctx.vars.sessionStreams.set(sessionId, unsubscribe);
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
			.select({ id: tabs.id })
			.from(tabs)
			.where(eq(tabs.sessionId, sessionId))
			.limit(1);

		if (existing.length === 0) {
			await tx.insert(tabs).values({
				id: tabId,
				type: "session",
				title: nextTitle,
				sessionId,
				createdAt: now,
				updatedAt: now,
				archivedAt: null,
			});
			return;
		}

		if (title) {
			await tx
				.update(tabs)
				.set({ title, updatedAt: now })
				.where(eq(tabs.sessionId, sessionId));
		}
	});

	await ctx.broadcastTabsChanged();
}

async function sendMessage(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	content: string
): Promise<void> {
	await ensureSession(ctx, sessionId);

	const session = await ctx.vars.sandboxClient.resumeOrCreateSession({
		id: sessionId,
		agent: DEFAULT_AGENT,
	});
	ensureEventListener(ctx, session);

	await session.prompt([{ type: "text", text: content }]);
}

async function getTranscript(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	offset: number,
	limit?: number
): Promise<SessionEvent[]> {
	const persist = new RivetSessionPersistDriver(ctx);
	const page = await persist.listEvents({
		sessionId,
		cursor: offset > 0 ? String(offset) : undefined,
		limit,
	});
	return page.items;
}

async function listTabs(ctx: SpaceRuntimeContext): Promise<SessionTab[]> {
	const persist = new RivetSessionPersistDriver(ctx);

	const [rows, sessionsPage] = await Promise.all([
		ctx.vars.db
			.select({
				tabId: tabs.id,
				title: tabs.title,
				sessionId: tabs.sessionId,
				createdAt: tabs.createdAt,
				updatedAt: tabs.updatedAt,
				archivedAt: tabs.archivedAt,
			})
			.from(tabs)
			.where(
				and(
					eq(tabs.type, "session"),
					isNull(tabs.archivedAt),
					isNotNull(tabs.sessionId)
				)
			)
			.orderBy(desc(tabs.updatedAt), asc(tabs.createdAt)),
		persist.listSessions(),
	]);

	const sessionsByKey = new Map(sessionsPage.items.map((s) => [s.id, s]));

	return rows.map((row) => {
		const sessionId = row.sessionId as string;
		const record = sessionsByKey.get(sessionId);
		return {
			id: row.tabId,
			type: "session" as const,
			title: row.title,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			archivedAt: row.archivedAt,
			sessionId,
			agent: record?.agent ?? null,
		};
	});
}

function onSleep(ctx: SpaceRuntimeContext): Promise<void> {
	abortAllSessionStreams(ctx);
	return Promise.resolve();
}

type SessionPublicActions = {
	sendMessage: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		content: string
	) => Promise<void>;
	getTranscript: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		offset: number,
		limit?: number
	) => Promise<SessionEvent[]>;
};

type SessionDriver = TabDriverLifecycle<SessionPublicActions> & {
	publicActions: SessionPublicActions;
};

export const sessionDriver: SessionDriver = {
	kind: "session",
	onSleep,
	listTabs,
	publicActions: {
		sendMessage,
		getTranscript,
	},
};
