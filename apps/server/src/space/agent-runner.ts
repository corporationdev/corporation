import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import {
	promptRequestBodySchema,
	turnRunnerCallbackPayloadSchema,
} from "@corporation/shared/session-protocol";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sessionEvents, sessions } from "../db/schema";
import { refreshSandboxTimeout } from "./action-registration";
import { createTabChannel, publishToChannel } from "./subscriptions";
import type { SpaceRuntimeContext } from "./types";

const SESSION_EVENT_NAME = "session.event";
const SESSION_STATUS_EVENT_NAME = "session.status";
const TRAILING_SLASH_RE = /\/$/;
const AGENT_RUNNER_ACTION = "ingestAgentRunnerBatch";
const log = createLogger("space:agent-runner");

type TextPromptPart = { type: "text"; text: string };

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

async function launchAgentRunner(
	ctx: SpaceRuntimeContext,
	params: {
		turnId: string;
		sessionId: string;
		agent: string;
		modelId: string;
		prompt: TextPromptPart[];
		callbackUrl: string;
		callbackToken: string;
	}
): Promise<void> {
	const promptUrl = `${ctx.state.agentUrl}/v1/prompt`;
	const response = await fetch(promptUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(
			promptRequestBodySchema.parse({
				turnId: params.turnId,
				sessionId: params.sessionId,
				agent: params.agent,
				modelId: params.modelId,
				prompt: params.prompt,
				cwd: ctx.state.workdir,
				callbackUrl: params.callbackUrl,
				callbackToken: params.callbackToken,
			})
		),
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`corp-agent prompt failed (${response.status}): ${text}`);
	}
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
	const callbackUrl = `${baseUrl.replace(TRAILING_SLASH_RE, "")}/rivet/gateway/${encodeURIComponent(ctx.actorId)}/action/${AGENT_RUNNER_ACTION}`;
	await ctx.vars.db
		.update(sessions)
		.set({
			runId: turnId,
			status: "running",
			callbackToken,
			error: null,
		})
		.where(eq(sessions.id, params.sessionId));
	ctx.vars.agentRunnerSequenceBySessionId.set(params.sessionId, 0);
	publishSessionStatus(ctx, params.sessionId, "running");

	refreshSandboxTimeout(ctx);

	try {
		await launchAgentRunner(ctx, {
			turnId,
			sessionId: params.sessionId,
			agent: params.agent,
			modelId: params.modelId,
			prompt: params.prompt,
			callbackUrl,
			callbackToken,
		});
	} catch (error) {
		log.error(
			{ err: error, actorId: ctx.actorId, sessionId: params.sessionId, turnId },
			"launchAgentRunner failed"
		);
		await ctx.vars.db
			.update(sessions)
			.set({
				status: "error",
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			})
			.where(eq(sessions.id, params.sessionId));
		throw error;
	}
}

export async function ingestAgentRunnerBatch(
	ctx: SpaceRuntimeContext,
	payload: unknown
): Promise<void> {
	const result = turnRunnerCallbackPayloadSchema.safeParse(payload);
	if (!result.success) {
		log.error(
			{ err: result.error.message, actorId: ctx.actorId, payload },
			"failed to parse callback payload"
		);
		throw new Error(`Invalid callback payload: ${result.error.message}`);
	}
	const parsed = result.data;

	const [session] = await ctx.vars.db
		.select({
			id: sessions.id,
			runId: sessions.runId,
			callbackToken: sessions.callbackToken,
		})
		.from(sessions)
		.where(eq(sessions.id, parsed.sessionId))
		.limit(1);

	if (!session) {
		throw new Error(`Unknown session: ${parsed.sessionId}`);
	}

	if (session.runId !== parsed.turnId) {
		throw new Error("Stale callback for non-current run");
	}
	if (!session.callbackToken || session.callbackToken !== parsed.token) {
		throw new Error("Invalid callback token");
	}

	const lastSequence = ctx.vars.agentRunnerSequenceBySessionId.get(session.id);
	if (lastSequence !== undefined) {
		if (parsed.sequence <= lastSequence) {
			return;
		}
		if (parsed.sequence > lastSequence + 1) {
			log.warn(
				{
					actorId: ctx.actorId,
					sessionId: session.id,
					turnId: parsed.turnId,
					expected: lastSequence + 1,
					received: parsed.sequence,
				},
				"callback sequence gap detected; accepting newer callback"
			);
		}
	}

	if (parsed.kind === "events") {
		const validEvents = parsed.events.filter(
			(event) => event.sessionId === session.id
		);
		ctx.vars.agentRunnerSequenceBySessionId.set(session.id, parsed.sequence);
		if (validEvents.length === 0) {
			return;
		}
		for (const event of validEvents) {
			publishToChannel(
				ctx,
				createTabChannel("session", session.id),
				SESSION_EVENT_NAME,
				event
			);
		}
		await ctx.vars.db
			.insert(sessionEvents)
			.values(validEvents)
			.onConflictDoNothing({ target: sessionEvents.id });
		return;
	}

	if (parsed.kind === "completed") {
		await ctx.vars.db
			.update(sessions)
			.set({ status: "idle", pid: null, error: null })
			.where(eq(sessions.id, session.id));
		ctx.vars.agentRunnerSequenceBySessionId.set(session.id, parsed.sequence);
		publishSessionStatus(ctx, session.id, "idle");
		return;
	}

	if (parsed.kind === "failed") {
		await ctx.vars.db
			.update(sessions)
			.set({ status: "error", pid: null, error: parsed.error })
			.where(eq(sessions.id, session.id));
		ctx.vars.agentRunnerSequenceBySessionId.set(session.id, parsed.sequence);
		publishSessionStatus(ctx, session.id, "error");
		log.error(
			{ actorId: ctx.actorId, sessionId: session.id, turnId: parsed.turnId },
			"turn runner reported failure"
		);
	}
}
