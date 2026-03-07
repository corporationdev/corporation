import { createAnthropic } from "@ai-sdk/anthropic";
import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import { generateText, Output } from "ai";
import { asc, desc, eq } from "drizzle-orm";
import { hc } from "hono/client";
import type { SandboxRuntimeApp } from "sandbox-runtime/client";
import { z } from "zod";
import { startAgentRunner } from "./agent-runner";
import { type SessionRow, sessions } from "./db/schema";
import { appendSessionStatusFrame } from "./session-stream";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_SESSION_TITLE = "New Chat";

const log = createLogger("space:session");

export function listSessions(ctx: SpaceRuntimeContext): Promise<SessionRow[]> {
	return ctx.vars.db
		.select()
		.from(sessions)
		.orderBy(desc(sessions.updatedAt), asc(sessions.createdAt));
}

export async function broadcastSessionsChanged(
	ctx: SpaceRuntimeContext
): Promise<void> {
	ctx.broadcast("sessions.changed", await listSessions(ctx));
}

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
		.update(sessions)
		.set({ title, updatedAt: Date.now() })
		.where(eq(sessions.id, sessionId))
		.run();

	await broadcastSessionsChanged(ctx);
}

async function ensureSession(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	agent: string,
	modelId: string,
	title?: string
): Promise<void> {
	const now = Date.now();
	const nextTitle = title ?? DEFAULT_SESSION_TITLE;

	const existing = ctx.vars.db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1)
		.all();

	if (existing.length === 0) {
		ctx.vars.db
			.insert(sessions)
			.values({
				id: sessionId,
				title: nextTitle,
				agent,
				agentSessionId: "",
				lastConnectionId: "",
				createdAt: now,
				updatedAt: now,
				modelId,
			})
			.run();
	} else {
		const patch: {
			updatedAt: number;
			title?: string;
		} = {
			updatedAt: now,
		};
		if (title) {
			patch.title = title;
		}
		ctx.vars.db
			.update(sessions)
			.set(patch)
			.where(eq(sessions.id, sessionId))
			.run();
	}

	await broadcastSessionsChanged(ctx);
}

export async function sendMessage(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	content: string,
	agent: string,
	modelId: string
): Promise<void> {
	await ensureSession(ctx, sessionId, agent, modelId);

	// Auto-generate session title on first message of this session
	const sessionRow = ctx.vars.db
		.select({ title: sessions.title })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1)
		.all();
	if (sessionRow[0]?.title === DEFAULT_SESSION_TITLE) {
		ctx.waitUntil(
			requestAutoSessionTitle(ctx, sessionId, content).catch((error) => {
				log.warn(
					{ err: error, actorId: ctx.actorId, sessionId },
					"sendMessage: failed to auto-generate session title"
				);
			})
		);
	}

	const prompt = [{ type: "text" as const, text: content }];

	await startAgentRunner(ctx, {
		sessionId,
		prompt,
		agent,
		modelId,
	});
}

export async function cancelSession(
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
	appendSessionStatusFrame(ctx, {
		sessionId,
		status: "idle",
		reason: "run_cancelled",
	});

	if (runId) {
		const client = hc<SandboxRuntimeApp>(ctx.state.agentUrl);
		client.v1.prompt[":turnId"]
			.$delete(
				{ param: { turnId: runId } },
				{ init: { signal: AbortSignal.timeout(5000) } }
			)
			.catch((error) => {
				log.warn(
					{ sessionId, runId, err: error },
					"cancel-session.agent-cancel-failed"
				);
			});
	}
}
