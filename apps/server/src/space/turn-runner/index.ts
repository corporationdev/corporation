import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sessionEvents, sessions } from "../../db/schema";
import { refreshSandboxTimeout } from "../action-registration";
import { createTabChannel } from "../channels";
import { publishToChannel } from "../subscriptions";
import type { SpaceRuntimeContext } from "../types";
import {
	parseTurnRunnerCallbackPayload,
	type TurnRunnerCallbackPayload,
} from "./schema";
import type { SessionEvent } from "./types";

const SESSION_EVENT_NAME = "session.event";
const SESSION_STATUS_EVENT_NAME = "session.status";
const TRAILING_SLASH_RE = /\/$/;
const TURN_RUNNER_ACTION = "ingestTurnRunnerBatch";
const PERSIST_BATCH_SIZE = 128;
const log = createLogger("space:turn-runner");

type TextPromptPart = { type: "text"; text: string };

export const SESSION_STATUS_RUNNING = "running";
export const SESSION_STATUS_IDLE = "idle";
export const SESSION_STATUS_ERROR = "error";

export function publishSessionStatus(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	status: string
): void {
	publishToChannel(
		ctx,
		createTabChannel("session", sessionId),
		SESSION_STATUS_EVENT_NAME,
		{ sessionId, status }
	);
}

function publishSessionEvents(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	events: SessionEvent[]
): void {
	for (const event of events) {
		publishToChannel(
			ctx,
			createTabChannel("session", sessionId),
			SESSION_EVENT_NAME,
			event
		);
	}
}

async function persistSessionEvents(
	ctx: SpaceRuntimeContext,
	events: SessionEvent[]
): Promise<void> {
	if (events.length === 0) {
		return;
	}

	await ctx.vars.db
		.insert(sessionEvents)
		.values(
			events.map((event) => ({
				id: event.id,
				eventIndex: event.eventIndex,
				sessionId: event.sessionId,
				createdAt: event.createdAt,
				connectionId: event.connectionId,
				sender: event.sender,
				payload: event.payload as Record<string, unknown>,
			}))
		)
		.onConflictDoNothing({ target: sessionEvents.id });
}

async function flushPendingSessionEventInserts(
	ctx: SpaceRuntimeContext
): Promise<void> {
	while (ctx.vars.pendingSessionEventInserts.length > 0) {
		const batch = ctx.vars.pendingSessionEventInserts.splice(
			0,
			PERSIST_BATCH_SIZE
		);
		await persistSessionEvents(ctx, batch);
	}
}

function ensureSessionEventFlushScheduled(ctx: SpaceRuntimeContext): void {
	if (ctx.vars.pendingSessionEventFlush) {
		return;
	}

	const flushPromise = flushPendingSessionEventInserts(ctx)
		.catch((error) => {
			log.error(
				{ err: error, actorId: ctx.actorId },
				"session-event flush failed"
			);
		})
		.finally(() => {
			if (ctx.vars.pendingSessionEventFlush === flushPromise) {
				ctx.vars.pendingSessionEventFlush = null;
			}
			if (ctx.vars.pendingSessionEventInserts.length > 0) {
				ensureSessionEventFlushScheduled(ctx);
			}
		});

	ctx.vars.pendingSessionEventFlush = flushPromise;
	ctx.waitUntil(flushPromise);
}

function enqueueSessionEventInserts(
	ctx: SpaceRuntimeContext,
	events: SessionEvent[]
): void {
	if (events.length === 0) {
		return;
	}
	ctx.vars.pendingSessionEventInserts.push(...events);
	ensureSessionEventFlushScheduled(ctx);
}

async function flushAllSessionEventInserts(
	ctx: SpaceRuntimeContext
): Promise<void> {
	while (
		ctx.vars.pendingSessionEventFlush ||
		ctx.vars.pendingSessionEventInserts.length > 0
	) {
		ensureSessionEventFlushScheduled(ctx);
		const inFlight = ctx.vars.pendingSessionEventFlush;
		if (!inFlight) {
			break;
		}
		await inFlight;
	}
}

async function launchTurnRunner(
	ctx: SpaceRuntimeContext,
	params: {
		turnId: string;
		sessionId: string;
		agent: string;
		modelId: string;
		promptJson: string;
		callbackUrl: string;
		callbackToken: string;
	}
): Promise<void> {
	log.info(
		{ callbackUrl: params.callbackUrl, agentUrl: ctx.state.agentUrl },
		"launchTurnRunner: sending prompt to corp-agent"
	);

	const promptUrl = `${ctx.state.agentUrl}/v1/prompt`;
	const response = await fetch(promptUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			turnId: params.turnId,
			sessionId: params.sessionId,
			agent: params.agent,
			modelId: params.modelId,
			prompt: JSON.parse(params.promptJson),
			cwd: ctx.state.workdir,
			callbackUrl: params.callbackUrl,
			callbackToken: params.callbackToken,
		}),
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`corp-agent prompt failed (${response.status}): ${text}`);
	}
}

export async function ensureNoRunningTurn(
	ctx: SpaceRuntimeContext,
	sessionId: string
): Promise<void> {
	const existingSession = await ctx.vars.db
		.select({ status: sessions.status })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (existingSession[0]?.status === SESSION_STATUS_RUNNING) {
		throw new Error("Session already has a running turn");
	}
}

export async function startTurnRunner(
	ctx: SpaceRuntimeContext,
	params: {
		sessionId: string;
		prompt: TextPromptPart[];
		agent: string;
		modelId: string;
	}
): Promise<void> {
	const persistedSession = await ctx.vars.db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.id, params.sessionId))
		.limit(1);
	if (persistedSession.length === 0) {
		throw new Error("Session record not found");
	}

	const turnId = nanoid();
	const callbackToken = crypto.randomUUID();
	const baseUrl = env.SERVER_PUBLIC_URL;
	if (!baseUrl) {
		throw new Error("Missing SERVER_PUBLIC_URL env var");
	}
	const callbackUrl = `${baseUrl.replace(TRAILING_SLASH_RE, "")}/rivet/gateway/${encodeURIComponent(ctx.actorId)}/action/${TURN_RUNNER_ACTION}`;
	const promptJson = JSON.stringify(params.prompt);

	await ctx.vars.db
		.update(sessions)
		.set({
			runId: turnId,
			status: SESSION_STATUS_RUNNING,
			callbackToken,
			error: null,
		})
		.where(eq(sessions.id, params.sessionId));
	ctx.vars.turnRunnerSequenceBySessionId.set(params.sessionId, 0);
	publishSessionStatus(ctx, params.sessionId, SESSION_STATUS_RUNNING);

	refreshSandboxTimeout(ctx);

	try {
		await launchTurnRunner(ctx, {
			turnId,
			sessionId: params.sessionId,
			agent: params.agent,
			modelId: params.modelId,
			promptJson,
			callbackUrl,
			callbackToken,
		});
	} catch (error) {
		log.error(
			{ err: error, actorId: ctx.actorId, sessionId: params.sessionId, turnId },
			"launchTurnRunner failed"
		);
		await ctx.vars.db
			.update(sessions)
			.set({
				status: SESSION_STATUS_ERROR,
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			})
			.where(eq(sessions.id, params.sessionId));
		throw error;
	}
}

export async function ingestTurnRunnerBatch(
	ctx: SpaceRuntimeContext,
	payload: unknown
): Promise<void> {
	log.info(
		{
			actorId: ctx.actorId,
			payloadType: typeof payload,
			payloadKeys:
				payload && typeof payload === "object"
					? Object.keys(payload as Record<string, unknown>)
					: null,
		},
		"ingestTurnRunnerBatch called"
	);

	let parsed: TurnRunnerCallbackPayload;
	try {
		parsed = parseTurnRunnerCallbackPayload(payload);
	} catch (error) {
		log.error(
			{ err: error, actorId: ctx.actorId, payload },
			"failed to parse callback payload"
		);
		throw error;
	}

	const rows = await ctx.vars.db
		.select({
			id: sessions.id,
			runId: sessions.runId,
			callbackToken: sessions.callbackToken,
		})
		.from(sessions)
		.where(eq(sessions.id, parsed.sessionId))
		.limit(1);
	const session = rows[0];
	if (!session) {
		throw new Error(`Unknown session: ${parsed.sessionId}`);
	}

	if (session.runId !== parsed.turnId) {
		throw new Error("Stale callback for non-current run");
	}
	if (!session.callbackToken || session.callbackToken !== parsed.token) {
		throw new Error("Invalid callback token");
	}

	const lastSequence = ctx.vars.turnRunnerSequenceBySessionId.get(session.id);
	if (lastSequence !== undefined) {
		if (parsed.sequence <= lastSequence) {
			return;
		}
		if (parsed.sequence !== lastSequence + 1) {
			throw new Error(
				`Out-of-order callback sequence: expected ${lastSequence + 1}, got ${parsed.sequence}`
			);
		}
	}

	if (parsed.kind === "events") {
		const validEvents = parsed.events.filter(
			(event) => event.sessionId === session.id
		);
		ctx.vars.turnRunnerSequenceBySessionId.set(session.id, parsed.sequence);
		if (validEvents.length === 0) {
			return;
		}
		publishSessionEvents(ctx, session.id, validEvents);
		enqueueSessionEventInserts(ctx, validEvents);
		return;
	}

	if (parsed.kind === "completed") {
		await flushAllSessionEventInserts(ctx);
		await ctx.vars.db
			.update(sessions)
			.set({ status: SESSION_STATUS_IDLE, pid: null, error: null })
			.where(eq(sessions.id, session.id));
		ctx.vars.turnRunnerSequenceBySessionId.set(session.id, parsed.sequence);
		publishSessionStatus(ctx, session.id, SESSION_STATUS_IDLE);
		return;
	}

	if (parsed.kind === "failed") {
		await flushAllSessionEventInserts(ctx);
		await ctx.vars.db
			.update(sessions)
			.set({ status: SESSION_STATUS_ERROR, pid: null, error: parsed.error })
			.where(eq(sessions.id, session.id));
		ctx.vars.turnRunnerSequenceBySessionId.set(session.id, parsed.sequence);
		publishSessionStatus(ctx, session.id, SESSION_STATUS_ERROR);
		log.error(
			{ actorId: ctx.actorId, sessionId: session.id, turnId: parsed.turnId },
			"turn runner reported failure"
		);
	}
}
