import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { AgentListResponse, SessionEvent } from "sandbox-agent";
import { type SessionTab, sessions, tabs } from "../db/schema";
import { createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import {
	buildPromptWithReplay,
	type SessionPromptPart,
} from "./session-replay-context";
import {
	ensureNoRunningTurn,
	ingestTurnRunnerBatch,
	publishSessionStatus,
	SESSION_STATUS_IDLE,
	SESSION_STATUS_RUNNING,
	startTurnRunner,
} from "./turn-runner";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_SESSION_TITLE = "New Chat";
const AUTO_BRANCH_NAME_ENDPOINT = "/internal/auto-branch-name";
const log = createLogger("space:session");

async function ensureSession(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	title?: string
): Promise<void> {
	const now = Date.now();
	const tabId = createTabId("session", sessionId);
	const nextTitle = title ?? DEFAULT_SESSION_TITLE;

	ctx.vars.db.transaction((tx) => {
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

async function sendMessage(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	content: string,
	agent: string,
	modelId: string
): Promise<void> {
	const isFirstMessageForSpace = await hasNoSessionTabs(ctx);
	if (isFirstMessageForSpace) {
		ctx.waitUntil(
			requestAutoBranchName(ctx, content).catch((error) => {
				log.warn(
					{ err: error, actorId: ctx.actorId, sessionId },
					"sendMessage: failed to trigger auto branch naming"
				);
			})
		);
	}

	await ensureSession(ctx, sessionId);

	await ensureNoRunningTurn(ctx, sessionId);

	let prompt: SessionPromptPart[] = [{ type: "text", text: content }];
	try {
		prompt = await buildPromptWithReplay(ctx, sessionId, content);
	} catch (error) {
		log.warn(
			{ err: error, actorId: ctx.actorId, sessionId },
			"sendMessage: failed to build replay context"
		);
	}

	await ctx.vars.db
		.insert(sessions)
		.values({
			id: sessionId,
			agent,
			agentSessionId: "",
			lastConnectionId: "",
			createdAt: Date.now(),
			modelId,
		})
		.onConflictDoNothing({ target: sessions.id });

	await startTurnRunner(ctx, {
		sessionId,
		prompt,
		agent,
		modelId,
	});
}

async function listAgents(
	ctx: SpaceRuntimeContext
): Promise<AgentListResponse> {
	return await ctx.vars.sandboxClient.listAgents({ config: true });
}

async function cancelSession(
	ctx: SpaceRuntimeContext,
	sessionId: string
): Promise<void> {
	const sessionRows = await ctx.vars.db
		.select({
			id: sessions.id,
			status: sessions.status,
			pid: sessions.pid,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!sessionRows[0] || sessionRows[0].status !== SESSION_STATUS_RUNNING) {
		return;
	}

	const { pid } = sessionRows[0];

	// Clear run state and notify the frontend immediately.
	await ctx.vars.db
		.update(sessions)
		.set({
			status: SESSION_STATUS_IDLE,
			runId: null,
			pid: null,
			callbackToken: null,
			error: null,
		})
		.where(eq(sessions.id, sessionId));
	publishSessionStatus(ctx, sessionId, SESSION_STATUS_IDLE);

	// TODO: Investigate whether killing is the right approach here or whether
	// we keep the turn runner alive and just cancel the prompt.
	const killCmd = pid
		? `kill ${pid} 2>/dev/null || true`
		: "pkill -f corp-turn-runner || true";
	try {
		await ctx.vars.sandbox.commands.run(killCmd, {
			timeoutMs: 5000,
		});
	} catch (error) {
		log.warn(
			{ err: error, actorId: ctx.actorId, sessionId },
			"cancelSession: failed to kill turn-runner process"
		);
	}
}

async function getSessionState(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	offset: number,
	limit?: number
): Promise<{ events: SessionEvent[]; status: string }> {
	const [page, sessionRows] = await Promise.all([
		ctx.vars.persist.listEvents({
			sessionId,
			cursor: offset > 0 ? String(offset) : undefined,
			limit,
		}),
		ctx.vars.db
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1),
	]);
	const status = sessionRows[0]?.status ?? SESSION_STATUS_IDLE;
	return { events: page.items, status };
}

async function listTabs(ctx: SpaceRuntimeContext): Promise<SessionTab[]> {
	const [rows, sessionRows] = await Promise.all([
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
		ctx.vars.db
			.select({
				id: sessions.id,
				agent: sessions.agent,
				modelId: sessions.modelId,
			})
			.from(sessions),
	]);

	const sessionsByKey = new Map(sessionRows.map((s) => [s.id, s]));

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
			modelId: record?.modelId ?? null,
		};
	});
}

type SessionPublicActions = {
	sendMessage: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		content: string,
		agent: string,
		modelId: string
	) => Promise<void>;
	ingestTurnRunnerBatch: (
		ctx: SpaceRuntimeContext,
		payload: unknown
	) => Promise<void>;
	cancelSession: (ctx: SpaceRuntimeContext, sessionId: string) => Promise<void>;
	getSessionState: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		offset: number,
		limit?: number
	) => Promise<{ events: SessionEvent[]; status: string }>;
	listAgents: (ctx: SpaceRuntimeContext) => Promise<AgentListResponse>;
};

type SessionDriver = TabDriverLifecycle<SessionPublicActions> & {
	publicActions: SessionPublicActions;
};

export const sessionDriver: SessionDriver = {
	kind: "session",
	listTabs,
	publicActions: {
		sendMessage,
		ingestTurnRunnerBatch,
		cancelSession,
		getSessionState,
		listAgents,
	},
};
