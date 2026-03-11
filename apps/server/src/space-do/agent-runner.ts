import { turnRunnerCallbackPayloadSchema } from "@corporation/contracts/sandbox-do";
import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import { eq } from "drizzle-orm";
import { hc } from "hono/client";
import { nanoid } from "nanoid";
import type { SandboxRuntimeApp } from "sandbox-runtime/client";
import { createRuntimeAuthHeaders } from "./actor-auth";
import { sessions } from "./db/schema";
import { normalizeSessionEvent } from "./session-event-normalizer";
import {
	appendSessionEventFrames,
	appendSessionStatusFrame,
} from "./session-stream";
import { SANDBOX_WORKDIR, type SpaceRuntimeContext } from "./types";

const TRAILING_SLASH_RE = /\/$/;
const log = createLogger("space:agent-runner");

type TextPromptPart = { type: "text"; text: string };

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
		authToken: string;
	}
): Promise<void> {
	const binding = ctx.state.binding;
	if (!binding) {
		throw new Error("Sandbox runtime is not connected");
	}

	const client = hc<SandboxRuntimeApp>(binding.agentUrl);
	const response = await client.v1.prompt.$post(
		{
			json: {
				turnId: params.turnId,
				sessionId: params.sessionId,
				agent: params.agent,
				modelId: params.modelId,
				prompt: params.prompt,
				cwd: SANDBOX_WORKDIR,
				callbackUrl: params.callbackUrl,
				callbackToken: params.callbackToken,
			},
		},
		{
			headers: createRuntimeAuthHeaders(params.authToken),
			init: { signal: AbortSignal.timeout(15_000) },
		}
	);

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`sandbox-runtime prompt failed (${response.status}): ${text}`
		);
	}
}

export async function startAgentRunner(
	ctx: SpaceRuntimeContext,
	params: {
		sessionId: string;
		prompt: TextPromptPart[];
		agent: string;
		modelId: string;
		authToken: string;
	}
): Promise<void> {
	if (!ctx.state.binding) {
		throw new Error("Sandbox runtime is not connected");
	}

	const turnId = nanoid();
	const callbackToken = crypto.randomUUID();
	const baseUrl = env.CORPORATION_SERVER_URL;
	if (!baseUrl) {
		throw new Error("Missing CORPORATION_SERVER_URL env var");
	}
	const callbackUrl = `${baseUrl.replace(TRAILING_SLASH_RE, "")}/api/spaces/${encodeURIComponent(ctx.key[0] ?? "")}/runtime/callbacks/agent-runner`;

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
				callbackToken,
				error: null,
			})
			.where(eq(sessions.id, params.sessionId))
			.run();
		return true;
	});

	if (!didStart) {
		throw new Error("Session already has a running turn");
	}

	ctx.vars.agentRunnerSequenceBySessionId.set(params.sessionId, 0);
	appendSessionStatusFrame(ctx, {
		sessionId: params.sessionId,
		status: "running",
		error: null,
		reason: "run_started",
	});

	try {
		await launchAgentRunner(ctx, {
			turnId,
			sessionId: params.sessionId,
			agent: params.agent,
			modelId: params.modelId,
			prompt: params.prompt,
			callbackUrl,
			callbackToken,
			authToken: params.authToken,
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
				runId: null,
				callbackToken: null,
				error: error instanceof Error ? error.message : String(error),
			})
			.where(eq(sessions.id, params.sessionId));
		appendSessionStatusFrame(ctx, {
			sessionId: params.sessionId,
			status: "error",
			error: error instanceof Error ? error.message : String(error),
			reason: "run_launch_failed",
		});
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
		// Late callbacks are expected after cancel/restart races.
		// Treat these as no-op so the runner can drain and release cleanly.
		log.warn(
			{
				actorId: ctx.actorId,
				sessionId: session.id,
				incomingTurnId: parsed.turnId,
				currentRunId: session.runId,
				kind: parsed.kind,
				sequence: parsed.sequence,
			},
			"ignoring stale callback for non-current run"
		);
		return;
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
		if (validEvents.length > 0) {
			appendSessionEventFrames(
				ctx,
				session.id,
				validEvents.map(normalizeSessionEvent)
			);
		}
		ctx.vars.agentRunnerSequenceBySessionId.set(session.id, parsed.sequence);
		return;
	}

	if (parsed.kind === "completed") {
		await ctx.vars.db
			.update(sessions)
			.set({
				status: "idle",
				runId: null,
				callbackToken: null,
				pid: null,
				error: null,
			})
			.where(eq(sessions.id, session.id));
		ctx.vars.agentRunnerSequenceBySessionId.set(session.id, parsed.sequence);
		appendSessionStatusFrame(ctx, {
			sessionId: session.id,
			status: "idle",
			error: null,
			reason: "run_completed",
		});
		return;
	}

	if (parsed.kind === "failed") {
		await ctx.vars.db
			.update(sessions)
			.set({
				status: "error",
				runId: null,
				callbackToken: null,
				pid: null,
				error: parsed.error.message,
			})
			.where(eq(sessions.id, session.id));
		ctx.vars.agentRunnerSequenceBySessionId.set(session.id, parsed.sequence);
		appendSessionStatusFrame(ctx, {
			sessionId: session.id,
			status: "error",
			error: parsed.error.message,
			reason: "run_failed",
		});
		log.error(
			{ actorId: ctx.actorId, sessionId: session.id, turnId: parsed.turnId },
			"turn runner reported failure"
		);
	}
}
