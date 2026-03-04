import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { SessionEvent } from "sandbox-agent";
import { sessionEvents, sessions } from "../../db/schema";
import { refreshSandboxTimeout } from "../action-registration";
import { createTabChannel } from "../channels";
import { publishToChannel } from "../subscriptions";
import type { SpaceRuntimeContext } from "../types";
import {
	parseTurnRunnerCallbackPayload,
	type TurnRunnerCallbackPayload,
} from "./schema";

const SESSION_EVENT_NAME = "session.event";
const TRAILING_SLASH_RE = /\/$/;
const TURN_RUNNER_COMMAND = "corp-turn-runner";
const TURN_RUNNER_ACTION = "ingestTurnRunnerBatch";
const PID_SPLIT_RE = /\s+/;
const log = createLogger("space:turn-runner");

export const RUN_STATUS_RUNNING = "running";
export const RUN_STATUS_COMPLETED = "completed";
export const RUN_STATUS_FAILED = "failed";

function redactToken(token: string): string {
	if (token.length <= 8) {
		return token;
	}
	return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function payloadPreview(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		if (!serialized) {
			return "null";
		}
		return serialized.slice(0, 500);
	} catch {
		return "[unserializable payload]";
	}
}

function createCallbackToken(): string {
	return `${crypto.randomUUID()}${crypto.randomUUID()}`;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(TRAILING_SLASH_RE, "");
}

function getTurnRunnerCallbackUrl(ctx: SpaceRuntimeContext): string {
	const callbackBaseUrl = env.SERVER_PUBLIC_URL;
	if (!callbackBaseUrl) {
		log.error(
			{ actorId: ctx.actorId },
			"getTurnRunnerCallbackUrl: missing SERVER_PUBLIC_URL"
		);
		throw new Error("Missing SERVER_PUBLIC_URL env var");
	}

	const normalizedBaseUrl = normalizeBaseUrl(callbackBaseUrl);
	const callbackUrl = `${normalizedBaseUrl}/rivet/gateway/${encodeURIComponent(ctx.actorId)}/action/${TURN_RUNNER_ACTION}`;
	log.info(
		{ actorId: ctx.actorId, callbackUrl, callbackBaseUrl },
		"getTurnRunnerCallbackUrl: resolved callback URL"
	);
	return callbackUrl;
}

function createPromptPayload(content: string): string {
	return JSON.stringify([{ type: "text", text: content }]);
}

function maxNullable(
	currentValue: number | null,
	nextValue: number | null
): number | null {
	if (nextValue === null) {
		return currentValue;
	}
	if (currentValue === null) {
		return nextValue;
	}
	return Math.max(currentValue, nextValue);
}

function getLastEventIndex(
	payload: TurnRunnerCallbackPayload,
	insertedMaxEventIndex: number | null,
	currentLastEventIndex: number | null
): number | null {
	let result = maxNullable(currentLastEventIndex, insertedMaxEventIndex);
	if (typeof payload.lastEventIndex === "number") {
		result = maxNullable(result, payload.lastEventIndex);
	}
	return result;
}

async function insertSessionEvents(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	events: SessionEvent[]
): Promise<number | null> {
	log.info(
		{ actorId: ctx.actorId, sessionId, eventCount: events.length },
		"insertSessionEvents: begin"
	);
	let maxEventIndex: number | null = null;
	let insertedCount = 0;
	let skippedCount = 0;

	for (const event of events) {
		if (event.sessionId !== sessionId) {
			skippedCount += 1;
			log.warn(
				{
					actorId: ctx.actorId,
					sessionId,
					eventId: event.id,
					eventSessionId: event.sessionId,
				},
				"insertSessionEvents: skipping event with mismatched sessionId"
			);
			continue;
		}

		await ctx.vars.db
			.insert(sessionEvents)
			.values({
				id: event.id,
				eventIndex: event.eventIndex,
				sessionId: event.sessionId,
				createdAt: event.createdAt,
				connectionId: event.connectionId,
				sender: event.sender,
				payload: event.payload as Record<string, unknown>,
			})
			.onConflictDoNothing({ target: sessionEvents.id });

		publishToChannel(
			ctx,
			createTabChannel("session", sessionId),
			SESSION_EVENT_NAME,
			event
		);
		insertedCount += 1;
		log.info(
			{
				actorId: ctx.actorId,
				sessionId,
				eventId: event.id,
				eventIndex: event.eventIndex,
				sender: event.sender,
			},
			"insertSessionEvents: inserted + broadcasted event"
		);

		maxEventIndex = maxNullable(maxEventIndex, event.eventIndex);
	}

	log.info(
		{
			actorId: ctx.actorId,
			sessionId,
			insertedCount,
			skippedCount,
			maxEventIndex,
		},
		"insertSessionEvents: done"
	);

	return maxEventIndex;
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
		{
			actorId: ctx.actorId,
			sessionId: params.sessionId,
			turnId: params.turnId,
			agent: params.agent,
			modelId: params.modelId,
			callbackUrl: params.callbackUrl,
			callbackToken: redactToken(params.callbackToken),
			agentUrl: ctx.state.agentUrl,
			workdir: ctx.state.workdir,
			promptJsonLength: params.promptJson.length,
		},
		"launchTurnRunner: starting background command"
	);

	const launchResult = await ctx.vars.sandbox.commands.run(
		`nohup ${TURN_RUNNER_COMMAND} >/tmp/corp-turn-runner.stdout.log 2>&1 & echo $!`,
		{
			cwd: ctx.state.workdir,
			timeoutMs: 15_000,
			user: "root",
			envs: {
				TURN_ID: params.turnId,
				SESSION_ID: params.sessionId,
				AGENT: params.agent,
				MODEL_ID: params.modelId,
				PROMPT_JSON: params.promptJson,
				AGENT_URL: ctx.state.agentUrl,
				CALLBACK_URL: params.callbackUrl,
				CALLBACK_TOKEN: params.callbackToken,
				CALLBACK_MODE: "rivet-action",
				CWD: ctx.state.workdir,
			},
		}
	);

	const launchedPid = Number.parseInt(
		(launchResult.stdout ?? "").trim().split(PID_SPLIT_RE).at(-1) ?? "",
		10
	);

	log.info(
		{
			actorId: ctx.actorId,
			sessionId: params.sessionId,
			turnId: params.turnId,
			pid: Number.isFinite(launchedPid) ? launchedPid : null,
			launchStdout: (launchResult.stdout ?? "").trim(),
			launchStderr: (launchResult.stderr ?? "").trim() || null,
		},
		"launchTurnRunner: background command started"
	);
}

export async function ensureNoRunningTurn(
	ctx: SpaceRuntimeContext,
	sessionId: string
): Promise<void> {
	const existingSession = await ctx.vars.db
		.select({ runStatus: sessions.runStatus })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (existingSession[0]?.runStatus === RUN_STATUS_RUNNING) {
		log.warn(
			{
				actorId: ctx.actorId,
				sessionId,
				runStatus: existingSession[0]?.runStatus,
			},
			"ensureNoRunningTurn: blocked because session already has running turn"
		);
		throw new Error("Session already has a running turn");
	}
}

export async function startTurnRunner(
	ctx: SpaceRuntimeContext,
	params: {
		sessionId: string;
		content: string;
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
		throw new Error("Session record not found after resumeOrCreateSession");
	}

	const turnId = nanoid();
	const callbackToken = createCallbackToken();
	const callbackUrl = getTurnRunnerCallbackUrl(ctx);
	const promptJson = createPromptPayload(params.content);
	const now = Date.now();

	await ctx.vars.db
		.update(sessions)
		.set({
			runId: turnId,
			runStatus: RUN_STATUS_RUNNING,
			runStartedAt: now,
			runCompletedAt: null,
			lastEventAt: now,
			lastEventIndex: null,
			callbackToken,
			runStopReason: null,
			runError: null,
		})
		.where(eq(sessions.id, params.sessionId));

	log.info(
		{
			actorId: ctx.actorId,
			sessionId: params.sessionId,
			turnId,
			callbackUrl,
			callbackToken: redactToken(callbackToken),
		},
		"startTurnRunner: persisted run metadata"
	);

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
		log.info(
			{ actorId: ctx.actorId, sessionId: params.sessionId, turnId },
			"startTurnRunner: launchTurnRunner succeeded"
		);
	} catch (error) {
		log.error(
			{ err: error, actorId: ctx.actorId, sessionId: params.sessionId, turnId },
			"startTurnRunner: launchTurnRunner failed"
		);
		await ctx.vars.db
			.update(sessions)
			.set({
				runStatus: RUN_STATUS_FAILED,
				runCompletedAt: Date.now(),
				runError: {
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
			isArray: Array.isArray(payload),
		},
		"ingestTurnRunnerBatch: received callback payload"
	);

	let parsed: TurnRunnerCallbackPayload;
	try {
		parsed = parseTurnRunnerCallbackPayload(payload);
	} catch (error) {
		log.error(
			{
				err: error,
				actorId: ctx.actorId,
				payloadPreview: payloadPreview(payload),
			},
			"ingestTurnRunnerBatch: failed to parse callback payload"
		);
		throw error;
	}
	log.info(
		{
			actorId: ctx.actorId,
			sessionId: parsed.sessionId,
			turnId: parsed.turnId,
			kind: parsed.kind,
			sequence: parsed.sequence,
			lastEventIndex: parsed.lastEventIndex ?? null,
		},
		"ingestTurnRunnerBatch: parsed callback payload"
	);

	const rows = await ctx.vars.db
		.select({
			id: sessions.id,
			runId: sessions.runId,
			runStatus: sessions.runStatus,
			callbackToken: sessions.callbackToken,
			lastEventIndex: sessions.lastEventIndex,
		})
		.from(sessions)
		.where(eq(sessions.id, parsed.sessionId))
		.limit(1);
	const session = rows[0];
	if (!session) {
		log.error(
			{
				actorId: ctx.actorId,
				sessionId: parsed.sessionId,
				turnId: parsed.turnId,
				kind: parsed.kind,
			},
			"ingestTurnRunnerBatch: unknown session"
		);
		throw new Error(`Unknown session: ${parsed.sessionId}`);
	}

	if (session.runId !== parsed.turnId) {
		log.error(
			{
				actorId: ctx.actorId,
				sessionId: parsed.sessionId,
				expectedRunId: session.runId,
				receivedRunId: parsed.turnId,
				kind: parsed.kind,
			},
			"ingestTurnRunnerBatch: stale callback turnId"
		);
		throw new Error("Stale callback for non-current run");
	}
	if (!session.callbackToken || session.callbackToken !== parsed.token) {
		log.error(
			{
				actorId: ctx.actorId,
				sessionId: parsed.sessionId,
				turnId: parsed.turnId,
				expectedToken: session.callbackToken
					? redactToken(session.callbackToken)
					: null,
				receivedToken: redactToken(parsed.token),
			},
			"ingestTurnRunnerBatch: invalid callback token"
		);
		throw new Error("Invalid callback token");
	}

	const now = Date.now();
	let insertedMaxEventIndex: number | null = null;
	if (parsed.kind === "events") {
		insertedMaxEventIndex = await insertSessionEvents(
			ctx,
			session.id,
			parsed.events
		);
		log.info(
			{
				actorId: ctx.actorId,
				sessionId: session.id,
				turnId: parsed.turnId,
				kind: parsed.kind,
				eventCount: parsed.events.length,
				insertedMaxEventIndex,
			},
			"ingestTurnRunnerBatch: processed events payload"
		);
	}

	const basePatch = {
		lastEventAt: now,
		lastEventIndex: getLastEventIndex(
			parsed,
			insertedMaxEventIndex,
			session.lastEventIndex
		),
	};

	if (parsed.kind === "completed") {
		await ctx.vars.db
			.update(sessions)
			.set({
				...basePatch,
				runStatus: RUN_STATUS_COMPLETED,
				runCompletedAt: now,
				runStopReason: parsed.stopReason,
				runError: null,
			})
			.where(eq(sessions.id, session.id));
		log.info(
			{
				actorId: ctx.actorId,
				sessionId: session.id,
				turnId: parsed.turnId,
				stopReason: parsed.stopReason,
				lastEventIndex: basePatch.lastEventIndex,
			},
			"ingestTurnRunnerBatch: marked run completed"
		);
		return;
	}

	if (parsed.kind === "failed") {
		await ctx.vars.db
			.update(sessions)
			.set({
				...basePatch,
				runStatus: RUN_STATUS_FAILED,
				runCompletedAt: now,
				runError: parsed.error,
			})
			.where(eq(sessions.id, session.id));
		log.error(
			{
				actorId: ctx.actorId,
				sessionId: session.id,
				turnId: parsed.turnId,
				error: parsed.error,
				lastEventIndex: basePatch.lastEventIndex,
			},
			"ingestTurnRunnerBatch: marked run failed"
		);
		return;
	}

	await ctx.vars.db
		.update(sessions)
		.set(basePatch)
		.where(eq(sessions.id, session.id));
	log.info(
		{
			actorId: ctx.actorId,
			sessionId: session.id,
			turnId: parsed.turnId,
			kind: parsed.kind,
			lastEventIndex: basePatch.lastEventIndex,
		},
		"ingestTurnRunnerBatch: updated event tracking state"
	);
}
