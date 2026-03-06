import { createAnthropic } from "@ai-sdk/anthropic";
import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import type { SessionEvent } from "@corporation/shared/session-protocol";
import { generateText, Output } from "ai";
import { and, asc, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { type SessionTab, sessionEvents, sessions, tabs } from "../db/schema";
import {
	ingestAgentRunnerBatch,
	publishSessionStatus,
	startAgentRunner,
} from "./agent-runner";
import { createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import {
	buildPromptWithReplay,
	type SessionPromptPart,
} from "./session-replay-context";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_SESSION_TITLE = "New Chat";
const SESSION_STATUS_IDLE = "idle";
const SESSION_STATUS_RUNNING = "running";
const AUTO_BRANCH_NAME_ENDPOINT = "/internal/auto-branch-name";
const log = createLogger("space:session");

async function requestAutoSessionTitle(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	firstMessage: string
): Promise<void> {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		return;
	}

	const provider = createAnthropic({ apiKey });

	const prompt = [
		"Generate a very short title (2-6 words) for a chat session based on the user's first message.",
		"Rules:",
		"- Be concise and descriptive.",
		"- Use title case.",
		"- Do not use quotes or punctuation at the end.",
		"- Capture the main intent or topic.",
		`User message: ${firstMessage}`,
	].join("\n");

	const { output } = await generateText({
		model: provider("claude-haiku-4-5"),
		output: Output.object({ schema: z.object({ title: z.string() }) }),
		temperature: 0,
		prompt,
	});

	const title = output?.title.trim();
	if (!title) {
		return;
	}

	ctx.vars.db
		.update(tabs)
		.set({ title, updatedAt: Date.now() })
		.where(eq(tabs.sessionId, sessionId))
		.run();

	await ctx.broadcastTabsChanged();
}

async function ensureSession(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	agent: string,
	modelId: string,
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
		} else {
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
		}

		tx.insert(sessions)
			.values({
				id: sessionId,
				agent,
				agentSessionId: "",
				lastConnectionId: "",
				createdAt: now,
				modelId,
			})
			.onConflictDoNothing({ target: sessions.id })
			.run();
	});

	await ctx.broadcastTabsChanged();
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
	const existingTabs = await ctx.vars.db
		.select({ id: tabs.id })
		.from(tabs)
		.where(eq(tabs.type, "session"))
		.limit(1);
	if (existingTabs.length === 0) {
		ctx.waitUntil(
			requestAutoBranchName(ctx, content).catch((error) => {
				log.warn(
					{ err: error, actorId: ctx.actorId, sessionId },
					"sendMessage: failed to trigger auto branch naming"
				);
			})
		);
	}

	await ensureSession(ctx, sessionId, agent, modelId);

	// Auto-generate tab title on first message of this session
	const tabRow = ctx.vars.db
		.select({ title: tabs.title })
		.from(tabs)
		.where(eq(tabs.sessionId, sessionId))
		.limit(1)
		.all();
	if (tabRow[0]?.title === DEFAULT_SESSION_TITLE) {
		ctx.waitUntil(
			requestAutoSessionTitle(ctx, sessionId, content).catch((error) => {
				log.warn(
					{ err: error, actorId: ctx.actorId, sessionId },
					"sendMessage: failed to auto-generate session title"
				);
			})
		);
	}

	// Prevent sending a new message while a turn is already running
	const existing = await ctx.vars.db
		.select({ status: sessions.status })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (existing[0]?.status === SESSION_STATUS_RUNNING) {
		throw new Error("Session already has a running turn");
	}

	let prompt: SessionPromptPart[] = [{ type: "text", text: content }];
	try {
		prompt = await buildPromptWithReplay(ctx, sessionId, content);
	} catch (error) {
		log.warn(
			{ err: error, actorId: ctx.actorId, sessionId },
			"sendMessage: failed to build replay context"
		);
	}

	await startAgentRunner(ctx, {
		sessionId,
		prompt,
		agent,
		modelId,
	});
}

async function cancelSession(
	ctx: SpaceRuntimeContext,
	sessionId: string
): Promise<void> {
	const sessionRows = await ctx.vars.db
		.select({
			id: sessions.id,
			status: sessions.status,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!sessionRows[0] || sessionRows[0].status !== SESSION_STATUS_RUNNING) {
		return;
	}
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

	// TODO: Add a cancel endpoint to corp-agent to gracefully cancel the ACP prompt.
	// For now, cancelling just clears the session state on the actor side.
}

async function getSessionState(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	offset: number,
	limit?: number
): Promise<{ events: SessionEvent[]; status: string }> {
	const conditions = [eq(sessionEvents.sessionId, sessionId)];
	if (offset > 0) {
		conditions.push(gt(sessionEvents.eventIndex, offset));
	}

	const [eventRows, sessionRows] = await Promise.all([
		ctx.vars.db
			.select()
			.from(sessionEvents)
			.where(and(...conditions))
			.orderBy(asc(sessionEvents.eventIndex))
			.limit(limit ?? 100),
		ctx.vars.db
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1),
	]);

	const events: SessionEvent[] = eventRows.map((r) => ({
		id: r.id,
		eventIndex: r.eventIndex,
		sessionId: r.sessionId,
		createdAt: r.createdAt,
		connectionId: r.connectionId,
		sender: r.sender as SessionEvent["sender"],
		payload: r.payload as SessionEvent["payload"],
	}));

	const status = sessionRows[0]?.status ?? SESSION_STATUS_IDLE;
	return { events, status };
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
	ingestAgentRunnerBatch: (
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
};

type SessionDriver = TabDriverLifecycle<SessionPublicActions> & {
	publicActions: SessionPublicActions;
};

export const sessionDriver: SessionDriver = {
	kind: "session",
	listTabs,
	publicActions: {
		sendMessage,
		ingestAgentRunnerBatch,
		cancelSession,
		getSessionState,
	},
};
