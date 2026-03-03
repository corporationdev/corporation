import { env } from "@corporation/env/server";
import { RivetSessionPersistDriver } from "@sandbox-agent/persist-rivet";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Session, SessionEvent } from "sandbox-agent";
import { type SessionTab, tabs } from "../db/schema";
import { refreshSandboxTimeout } from "./action-registration";
import { createTabChannel, createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import { publishToChannel } from "./subscriptions";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_SESSION_TITLE = "New Chat";
const DEFAULT_AGENT = "opencode";
const DEFAULT_MODEL_ID = "anthropic/claude-opus-4-6";
const SESSION_EVENT_NAME = "session.event";
const AUTO_BRANCH_NAME_ENDPOINT = "/internal/auto-branch-name";

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
		refreshSandboxTimeout(ctx);
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

	await ctx.vars.db.transaction((tx) => {
		const existing = tx
			.select({ id: tabs.id })
			.from(tabs)
			.where(eq(tabs.sessionId, sessionId))
			.limit(1)
			.all();

		if (existing.length === 0) {
			tx.insert(tabs)
				.values({
					id: tabId,
					type: "session",
					title: nextTitle,
					sessionId,
					active: true,
					createdAt: now,
					updatedAt: now,
					archivedAt: null,
				})
				.run();
			return;
		}

		const tabPatch: {
			active: boolean;
			archivedAt: null;
			updatedAt: number;
			title?: string;
		} = {
			active: true,
			archivedAt: null,
			updatedAt: now,
		};
		if (title) {
			tabPatch.title = title;
		}
		tx.update(tabs).set(tabPatch).where(eq(tabs.sessionId, sessionId)).run();
	});

	await ctx.broadcastTabsChanged();
}

async function sendMessage(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	content: string
): Promise<void> {
	const isFirstMessageForSpace = await hasNoSessionTabs(ctx);
	if (isFirstMessageForSpace) {
		ctx.waitUntil(
			requestAutoBranchName(ctx, content).catch((error) => {
				console.warn("Failed to trigger auto branch naming", error);
			})
		);
	}

	await ensureSession(ctx, sessionId);
	const existingSession = await ctx.vars.sandboxClient.getSession(sessionId);

	const session = await ctx.vars.sandboxClient.resumeOrCreateSession({
		id: sessionId,
		agent: DEFAULT_AGENT,
		sessionInit: {
			cwd: ctx.state.workdir,
			mcpServers: [],
		},
	});
	ensureEventListener(ctx, session);
	if (!existingSession) {
		await applyDefaultModel(session);
	}

	ctx.waitUntil(
		session
			.prompt([{ type: "text", text: content }])
			.then(() => undefined)
			.catch((error) => {
				console.error("Failed to send session prompt", error);
			})
	);
}

async function hasNoSessionTabs(ctx: SpaceRuntimeContext): Promise<boolean> {
	const existingTabs = await ctx.vars.db
		.select({ id: tabs.id })
		.from(tabs)
		.where(eq(tabs.type, "session"))
		.limit(1);
	return existingTabs.length === 0;
}

async function requestAutoBranchName(
	ctx: SpaceRuntimeContext,
	firstMessage: string
): Promise<void> {
	const convexSiteUrl = env.CONVEX_SITE_URL;
	const internalApiKey = env.INTERNAL_API_KEY;
	if (!(convexSiteUrl && internalApiKey)) {
		return;
	}

	const response = await fetch(`${convexSiteUrl}${AUTO_BRANCH_NAME_ENDPOINT}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${internalApiKey}`,
		},
		body: JSON.stringify({
			sandboxId: ctx.state.sandboxId,
			firstMessage,
		}),
	});

	if (!response.ok) {
		throw new Error(`Auto branch endpoint failed: ${response.status}`);
	}
}

async function applyDefaultModel(session: Session): Promise<void> {
	try {
		await session.send("unstable/set_session_model", {
			modelId: DEFAULT_MODEL_ID,
		});
		return;
	} catch {
		// Fall through to protocol-native method name.
	}

	try {
		await session.send("session/set_model", {
			modelId: DEFAULT_MODEL_ID,
		});
	} catch (error) {
		console.warn("Failed to set default session model", error);
	}
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
				active: tabs.active,
				sessionId: tabs.sessionId,
				createdAt: tabs.createdAt,
				updatedAt: tabs.updatedAt,
				archivedAt: tabs.archivedAt,
			})
			.from(tabs)
			.where(
				and(
					eq(tabs.type, "session"),
					eq(tabs.active, true),
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
			active: row.active,
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
