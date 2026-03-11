import type {
	RuntimeCommandRejectedMessage,
	RuntimeSessionEventBatchMessage,
	RuntimeStartTurnMessage,
	RuntimeTurnCompletedMessage,
	RuntimeTurnFailedMessage,
} from "@corporation/contracts/sandbox-do";
import { createLogger } from "@corporation/logger";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sessions } from "./db/schema";
import { normalizeSessionEvent } from "./session-event-normalizer";
import {
	appendSessionEventFrames,
	appendSessionStatusFrame,
} from "./session-stream";
import { SANDBOX_WORKDIR, type SpaceRuntimeContext } from "./types";

const log = createLogger("space:agent-runner");

type TextPromptPart = { type: "text"; text: string };

async function failSessionRun(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	turnId: string,
	errorMessage: string,
	reason: string
): Promise<void> {
	const [session] = await ctx.vars.db
		.select({
			id: sessions.id,
			runId: sessions.runId,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);

	if (!session || session.runId !== turnId) {
		return;
	}

	await ctx.vars.db
		.update(sessions)
		.set({
			status: "error",
			runId: null,
			callbackToken: null,
			pid: null,
			error: errorMessage,
		})
		.where(eq(sessions.id, sessionId));
	appendSessionStatusFrame(ctx, {
		sessionId,
		status: "error",
		error: errorMessage,
		reason,
	});
}

export async function startAgentRunner(
	ctx: SpaceRuntimeContext,
	params: {
		sessionId: string;
		prompt: TextPromptPart[];
		agent: string;
		modelId: string;
	}
): Promise<void> {
	if (!ctx.runtime.isConnected()) {
		throw new Error("Sandbox runtime is not connected");
	}

	const turnId = nanoid();
	const commandId = nanoid();
	const didStart = ctx.vars.db.transaction((tx) => {
		const existingSession = tx
			.select({ id: sessions.id, status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, params.sessionId))
			.limit(1)
			.all()[0];

		if (!existingSession) {
			throw new Error("Session record not found");
		}

		if (existingSession.status === "running") {
			return false;
		}

		tx.update(sessions)
			.set({
				runId: turnId,
				status: "running",
				callbackToken: null,
				error: null,
			})
			.where(eq(sessions.id, params.sessionId))
			.run();
		return true;
	});

	if (!didStart) {
		throw new Error("Session already has a running turn");
	}

	appendSessionStatusFrame(ctx, {
		sessionId: params.sessionId,
		status: "running",
		error: null,
		reason: "run_started",
	});

	try {
		const message: RuntimeStartTurnMessage = {
			type: "start_turn",
			commandId,
			turnId,
			sessionId: params.sessionId,
			agent: params.agent,
			modelId: params.modelId,
			cwd: SANDBOX_WORKDIR,
			prompt: params.prompt,
		};
		ctx.runtime.send(message, {
			type: "start_turn",
			commandId,
			sessionId: params.sessionId,
			turnId,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Failed to send turn to runtime";
		log.error(
			{ err: error, actorId: ctx.actorId, sessionId: params.sessionId, turnId },
			"startAgentRunner failed to send start_turn"
		);
		await failSessionRun(
			ctx,
			params.sessionId,
			turnId,
			errorMessage,
			"run_launch_failed"
		);
		throw error;
	}
}

export async function ingestRuntimeSessionEventBatch(
	ctx: SpaceRuntimeContext,
	message: RuntimeSessionEventBatchMessage
): Promise<void> {
	const [session] = await ctx.vars.db
		.select({
			id: sessions.id,
			runId: sessions.runId,
		})
		.from(sessions)
		.where(eq(sessions.id, message.sessionId))
		.limit(1);

	if (!session || session.runId !== message.turnId) {
		return;
	}

	const validEvents = message.events.filter(
		(event) => event.sessionId === message.sessionId
	);
	if (validEvents.length === 0) {
		return;
	}

	appendSessionEventFrames(
		ctx,
		message.sessionId,
		validEvents.map(normalizeSessionEvent)
	);
}

export async function ingestRuntimeTurnCompleted(
	ctx: SpaceRuntimeContext,
	message: RuntimeTurnCompletedMessage
): Promise<void> {
	const [session] = await ctx.vars.db
		.select({
			id: sessions.id,
			runId: sessions.runId,
		})
		.from(sessions)
		.where(eq(sessions.id, message.sessionId))
		.limit(1);

	if (!session || session.runId !== message.turnId) {
		return;
	}

	await ctx.vars.db
		.update(sessions)
		.set({
			status: "idle",
			runId: null,
			callbackToken: null,
			pid: null,
			error: null,
		})
		.where(eq(sessions.id, message.sessionId));
	appendSessionStatusFrame(ctx, {
		sessionId: message.sessionId,
		status: "idle",
		error: null,
		reason: "run_completed",
	});
}

export async function ingestRuntimeTurnFailed(
	ctx: SpaceRuntimeContext,
	message: RuntimeTurnFailedMessage
): Promise<void> {
	await failSessionRun(
		ctx,
		message.sessionId,
		message.turnId,
		message.error.message,
		"run_failed"
	);
	log.error(
		{
			actorId: ctx.actorId,
			sessionId: message.sessionId,
			turnId: message.turnId,
		},
		"runtime reported turn failure"
	);
}

export async function ingestRuntimeCommandRejected(
	ctx: SpaceRuntimeContext,
	message: RuntimeCommandRejectedMessage,
	command:
		| {
				type: "start_turn";
				sessionId: string;
				turnId: string;
		  }
		| {
				type: "cancel_turn";
				sessionId: string;
				turnId: string;
		  }
		| null
): Promise<void> {
	if (!command) {
		return;
	}

	if (command.type === "start_turn") {
		await failSessionRun(
			ctx,
			command.sessionId,
			command.turnId,
			message.reason,
			"run_rejected"
		);
	}
}

export async function failRunningSessionsForRuntimeDisconnect(
	ctx: SpaceRuntimeContext,
	reason: string
): Promise<void> {
	const runningSessions = await ctx.vars.db
		.select({
			id: sessions.id,
			runId: sessions.runId,
		})
		.from(sessions)
		.where(eq(sessions.status, "running"));

	if (runningSessions.length === 0) {
		return;
	}

	const errorMessage = `Sandbox runtime disconnected: ${reason}`;
	for (const session of runningSessions) {
		if (!session.runId) {
			continue;
		}
		await failSessionRun(
			ctx,
			session.id,
			session.runId,
			errorMessage,
			"runtime_disconnected"
		);
	}
}
