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
const log = createLogger("space:turn-runner");

export const RUN_STATUS_RUNNING = "running";
export const RUN_STATUS_COMPLETED = "completed";
export const RUN_STATUS_FAILED = "failed";

async function insertSessionEvents(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	events: SessionEvent[]
): Promise<void> {
	const validEvents = events.filter((event) => event.sessionId === sessionId);
	if (validEvents.length === 0) {
		return;
	}

	await ctx.vars.db
		.insert(sessionEvents)
		.values(
			validEvents.map((event) => ({
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

	for (const event of validEvents) {
		publishToChannel(
			ctx,
			createTabChannel("session", sessionId),
			SESSION_EVENT_NAME,
			event
		);
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
	const launchCommand = [
		"set -euo pipefail",
		`command -v ${TURN_RUNNER_COMMAND} >/dev/null 2>&1`,
		`nohup ${TURN_RUNNER_COMMAND} >/tmp/corp-turn-runner.stdout.log 2>&1 &`,
		"pid=$!",
		'echo "$pid"',
		"sleep 0.25",
		'kill -0 "$pid" >/dev/null 2>&1',
	].join("; ");

	await ctx.vars.sandbox.commands.run(launchCommand, {
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
			CWD: ctx.state.workdir,
		},
	});
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
	const callbackToken = crypto.randomUUID();
	const baseUrl = env.SERVER_PUBLIC_URL;
	if (!baseUrl) {
		throw new Error("Missing SERVER_PUBLIC_URL env var");
	}
	const callbackUrl = `${baseUrl.replace(TRAILING_SLASH_RE, "")}/rivet/gateway/${encodeURIComponent(ctx.actorId)}/action/${TURN_RUNNER_ACTION}`;
	const promptJson = JSON.stringify([{ type: "text", text: params.content }]);
	const now = Date.now();

	await ctx.vars.db
		.update(sessions)
		.set({
			runId: turnId,
			runStatus: RUN_STATUS_RUNNING,
			runStartedAt: now,
			runCompletedAt: null,
			lastEventAt: now,
			callbackToken,
			runStopReason: null,
			runError: null,
		})
		.where(eq(sessions.id, params.sessionId));

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
	let parsed: TurnRunnerCallbackPayload;
	try {
		parsed = parseTurnRunnerCallbackPayload(payload);
	} catch (error) {
		log.error(
			{ err: error, actorId: ctx.actorId },
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

	const now = Date.now();
	if (parsed.kind === "events") {
		await insertSessionEvents(ctx, session.id, parsed.events);
	}

	const basePatch = { lastEventAt: now };

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
			{ actorId: ctx.actorId, sessionId: session.id, turnId: parsed.turnId },
			"turn runner reported failure"
		);
		return;
	}

	await ctx.vars.db
		.update(sessions)
		.set(basePatch)
		.where(eq(sessions.id, session.id));
}
