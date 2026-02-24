import { RivetSessionPersistDriver } from "@sandbox-agent/persist-rivet";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Session, SessionEvent } from "sandbox-agent";
import { SandboxAgent as SandboxAgentClient } from "sandbox-agent";
import { type SessionTab, sessions, tabs } from "../db/schema";
import { createTabChannel, createTabId } from "./channels";
import type { SandboxContextUpdate, TabDriverLifecycle } from "./driver-types";
import { publishToChannel } from "./subscriptions";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_SESSION_TITLE = "New Chat";
const DEFAULT_AGENT = "opencode";
const SESSION_EVENT_NAME = "session.event";

function connectSandbox(ctx: SpaceRuntimeContext, baseUrl: string) {
	return SandboxAgentClient.connect({
		baseUrl,
		persist: new RivetSessionPersistDriver(ctx),
	});
}

function abortAllSessionStreams(ctx: SpaceRuntimeContext): void {
	for (const unsubscribe of ctx.vars.sessionStreams.values()) {
		unsubscribe();
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
		? await connectSandbox(ctx, sandboxUrl)
		: null;
	abortAllSessionStreams(ctx);
}

function getSandboxClient(ctx: SpaceRuntimeContext): SandboxAgentClient {
	if (!ctx.vars.sandboxClient) {
		throw new Error("Sandbox is not ready for session operations");
	}
	return ctx.vars.sandboxClient;
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

async function sendMessage(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	content: string
): Promise<void> {
	await ensureSession(ctx, sessionId);

	const client = getSandboxClient(ctx);
	const session = await client.resumeOrCreateSession({
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

	return rows.map((row) => ({
		id: row.tabId,
		type: "session" as const,
		title: row.title,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		archivedAt: row.archivedAt,
		sessionId: row.sessionId,
		status: row.sessionStatus,
	}));
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
	onSandboxContextChanged,
	listTabs,
	publicActions: {
		ensureSession,
		sendMessage,
		getTranscript,
	},
};
