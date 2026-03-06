import { createAnthropic } from "@ai-sdk/anthropic";
import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import type { SessionEvent } from "@corporation/shared/session-protocol";
import { generateText, Output } from "ai";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { sessionEvents, sessions, tabs } from "../db/schema";
import {
	ingestAgentRunnerBatch,
	publishSessionStatus,
	startAgentRunner,
} from "./agent-runner";
import type { TabDriverLifecycle } from "./driver-types";
import {
	buildPromptWithReplay,
	type SessionPromptPart,
} from "./session-replay-context";
import {
	createTabChannel,
	createTabId,
	subscribeToChannel,
	unsubscribeFromChannel,
} from "./subscriptions";
import { broadcastTabsChanged } from "./tab-list";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_SESSION_TITLE = "New Chat";

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

	await broadcastTabsChanged(ctx);
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

	await broadcastTabsChanged(ctx);
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

	const response = await fetch(`${convexSiteUrl}/internal/auto-branch-name`, {
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
	const [existingSession] = await ctx.vars.db
		.select({ status: sessions.status })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (existingSession?.status === "running") {
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
			runId: sessions.runId,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!sessionRows[0] || sessionRows[0].status !== "running") {
		return;
	}
	const { runId } = sessionRows[0];

	// Clear run state and notify the frontend immediately.
	await ctx.vars.db
		.update(sessions)
		.set({
			status: "idle",
			runId: null,
			pid: null,
			callbackToken: null,
			error: null,
		})
		.where(eq(sessions.id, sessionId));
	publishSessionStatus(ctx, sessionId, "idle");

	if (runId) {
		fetch(`${ctx.state.agentUrl}/v1/prompt/${runId}`, {
			method: "DELETE",
			signal: AbortSignal.timeout(5000),
		}).catch((error) => {
			log.warn(
				{ sessionId, runId, err: error },
				"cancel-session.agent-cancel-failed"
			);
		});
	}
}

async function getSessionState(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	afterEventIndex: number,
	limit?: number
): Promise<{
	events: SessionEvent[];
	status: string;
	agent: string | null;
	modelId: string | null;
}> {
	const conditions = [eq(sessionEvents.sessionId, sessionId)];
	if (afterEventIndex > 0) {
		conditions.push(gt(sessionEvents.eventIndex, afterEventIndex));
	}

	const [events, [session]] = await Promise.all([
		ctx.vars.db
			.select()
			.from(sessionEvents)
			.where(and(...conditions))
			.orderBy(asc(sessionEvents.eventIndex))
			.limit(limit ?? 100),
		ctx.vars.db
			.select({
				status: sessions.status,
				agent: sessions.agent,
				modelId: sessions.modelId,
			})
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1),
	]);

	const status = session?.status ?? "idle";
	return {
		events,
		status,
		agent: session?.agent ?? null,
		modelId: session?.modelId ?? null,
	};
}

async function openSessionFeed(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	afterEventIndex = 0,
	limit?: number
): Promise<{
	events: SessionEvent[];
	status: string;
	agent: string | null;
	modelId: string | null;
	lastEventIndex: number;
}> {
	if (!ctx.conn) {
		throw new Error("Session feed requires an active connection");
	}

	subscribeToChannel(
		ctx.vars.subscriptions,
		createTabChannel("session", sessionId),
		ctx.conn.id
	);

	const { events, status, agent, modelId } = await getSessionState(
		ctx,
		sessionId,
		afterEventIndex,
		limit
	);
	const lastEventIndex =
		events.at(-1)?.eventIndex ?? Math.max(0, afterEventIndex);
	return { events, status, agent, modelId, lastEventIndex };
}

function closeSessionFeed(ctx: SpaceRuntimeContext, sessionId: string): void {
	if (!ctx.conn) {
		throw new Error("Session feed requires an active connection");
	}

	unsubscribeFromChannel(
		ctx.vars.subscriptions,
		createTabChannel("session", sessionId),
		ctx.conn.id
	);
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
	openSessionFeed: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		afterEventIndex?: number,
		limit?: number
	) => Promise<{
		events: SessionEvent[];
		status: string;
		agent: string | null;
		modelId: string | null;
		lastEventIndex: number;
	}>;
	closeSessionFeed: (ctx: SpaceRuntimeContext, sessionId: string) => void;
};

type SessionDriver = TabDriverLifecycle<SessionPublicActions> & {
	publicActions: SessionPublicActions;
};

export const sessionDriver: SessionDriver = {
	kind: "session",
	publicActions: {
		sendMessage,
		ingestAgentRunnerBatch,
		cancelSession,
		openSessionFeed,
		closeSessionFeed,
	},
};
