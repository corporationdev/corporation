import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { AgentListResponse, Session, SessionEvent } from "sandbox-agent";
import { type SessionTab, sessionEvents, sessions, tabs } from "../db/schema";
import { refreshSandboxTimeout } from "./action-registration";
import { createTabChannel, createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import { publishToChannel } from "./subscriptions";
import {
	parseTurnRunnerCallbackPayload,
	type TurnRunnerCallbackPayload,
} from "./turn-runner-contract";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_SESSION_TITLE = "New Chat";
const SESSION_EVENT_NAME = "session.event";
const AUTO_BRANCH_NAME_ENDPOINT = "/internal/auto-branch-name";
const ACP_SERVERS_PATH = "/v1/acp";
const TRAILING_SLASH_RE = /\/$/;
const TURN_RUNNER_COMMAND = "corp-turn-runner";
const TURN_RUNNER_ACTION = "ingestTurnRunnerBatch";
const RUN_STATUS_RUNNING = "running";
const RUN_STATUS_COMPLETED = "completed";
const RUN_STATUS_FAILED = "failed";
const log = createLogger("space:session");

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

async function ensureSession(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	title?: string
): Promise<void> {
	log.info(
		{ actorId: ctx.actorId, sessionId, title: title ?? null },
		"ensureSession: begin"
	);
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
	log.info({ actorId: ctx.actorId, sessionId, tabId }, "ensureSession: done");
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
		log.info(
			{ actorId: ctx.actorId, sandboxId: ctx.state.sandboxId },
			"requestAutoBranchName: skipped (missing env)"
		);
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

	log.info(
		{
			actorId: ctx.actorId,
			sandboxId: ctx.state.sandboxId,
			messageLength: firstMessage.length,
		},
		"requestAutoBranchName: success"
	);
}

async function applyModel(session: Session, modelId: string): Promise<boolean> {
	try {
		log.info({ sessionId: session.id, modelId }, "applyModel: trying unstable");
		await session.send("unstable/set_session_model", { modelId });
		log.info(
			{ sessionId: session.id, modelId },
			"applyModel: unstable success"
		);
		return true;
	} catch {
		// Fall through to protocol-native method name.
		log.warn(
			{ sessionId: session.id, modelId },
			"applyModel: unstable failed, trying session/set_model"
		);
	}

	try {
		await session.send("session/set_model", { modelId });
		log.info({ sessionId: session.id, modelId }, "applyModel: legacy success");
		return true;
	} catch (error) {
		log.warn(
			{ err: error, sessionId: session.id, modelId },
			"applyModel: failed to set model"
		);
		return false;
	}
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
		(launchResult.stdout ?? "").trim().split(/\s+/).at(-1) ?? "",
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

async function sendMessage(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	content: string,
	agent: string,
	modelId: string
): Promise<void> {
	log.info(
		{
			actorId: ctx.actorId,
			sessionId,
			agent,
			modelId,
			contentLength: content.length,
			workdir: ctx.state.workdir,
			agentUrl: ctx.state.agentUrl,
		},
		"sendMessage: begin"
	);

	const isFirstMessageForSpace = await hasNoSessionTabs(ctx);
	if (isFirstMessageForSpace) {
		log.info(
			{ actorId: ctx.actorId, sessionId },
			"sendMessage: first message in space, requesting auto branch name"
		);
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
			"sendMessage: blocked because session already has running turn"
		);
		throw new Error("Session already has a running turn");
	}

	const session = await ctx.vars.sandboxClient.resumeOrCreateSession({
		id: sessionId,
		agent,
		sessionInit: {
			cwd: ctx.state.workdir,
			mcpServers: [],
		},
	});

	const modelApplied = await applyModel(session, modelId);
	if (modelApplied) {
		await ctx.vars.persist.setModelId(sessionId, modelId);
		log.info(
			{ actorId: ctx.actorId, sessionId, modelId },
			"sendMessage: persisted modelId"
		);
	} else {
		log.warn(
			{ actorId: ctx.actorId, sessionId, modelId },
			"sendMessage: model not applied"
		);
	}

	const persistedSession = await ctx.vars.db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (persistedSession.length === 0) {
		throw new Error("Session record not found after resumeOrCreateSession");
	}

	const turnId = nanoid();
	const callbackToken = createCallbackToken();
	const callbackUrl = getTurnRunnerCallbackUrl(ctx);
	const promptJson = createPromptPayload(content);
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
		.where(eq(sessions.id, sessionId));

	log.info(
		{
			actorId: ctx.actorId,
			sessionId,
			turnId,
			callbackUrl,
			callbackToken: redactToken(callbackToken),
		},
		"sendMessage: persisted run metadata"
	);

	refreshSandboxTimeout(ctx);

	try {
		await launchTurnRunner(ctx, {
			turnId,
			sessionId,
			agent,
			modelId,
			promptJson,
			callbackUrl,
			callbackToken,
		});
		log.info(
			{ actorId: ctx.actorId, sessionId, turnId },
			"sendMessage: launchTurnRunner succeeded"
		);
	} catch (error) {
		log.error(
			{ err: error, actorId: ctx.actorId, sessionId, turnId },
			"sendMessage: launchTurnRunner failed"
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
			.where(eq(sessions.id, sessionId));
		throw error;
	}
}

async function ingestTurnRunnerBatch(
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

	// kind === "events" — update event tracking state
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

function listAgents(ctx: SpaceRuntimeContext): Promise<AgentListResponse> {
	return ctx.vars.sandboxClient.listAgents({ config: true });
}

async function cancelSession(
	ctx: SpaceRuntimeContext,
	sessionId: string
): Promise<void> {
	log.info({ actorId: ctx.actorId, sessionId }, "cancelSession: begin");
	// We read session data directly from our persist driver rather than going
	// through the sandbox-agent SDK, whose internal write queue serializes all
	// messages — a cancel notification would get stuck behind the in-flight
	// prompt POST.
	const record = await ctx.vars.persist.getSession(sessionId);
	if (!record) {
		log.warn({ actorId: ctx.actorId, sessionId }, "cancelSession: no session");
		return;
	}

	const baseUrl = ctx.state.agentUrl.replace(TRAILING_SLASH_RE, "");

	// Discover the active ACP server for this agent.
	// This is a sandbox-agent daemon API, not part of ACP itself.
	const serversRes = await fetch(`${baseUrl}${ACP_SERVERS_PATH}`, {
		headers: { Accept: "application/json" },
	});
	if (!serversRes.ok) {
		const responseText = await serversRes.text();
		throw new Error(
			`ACP server discovery failed during session cancel: ${serversRes.status} ${serversRes.statusText} ${responseText}`
		);
	}
	const { servers } = (await serversRes.json()) as {
		servers: { agent: string; serverId: string; createdAtMs: number }[];
	};
	const server = servers
		.filter((s) => s.agent === record.agent)
		.sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
	if (!server) {
		log.warn(
			{ actorId: ctx.actorId, sessionId, agent: record.agent },
			"cancelSession: no matching ACP server"
		);
		return;
	}

	// Raw POST instead of AcpHttpClient because the SDK is designed for
	// long-lived connections: it starts an SSE loop after the first POST
	// and sends a DELETE on disconnect that tears down the server. For a
	// fire-and-forget cancel notification, a single POST is all we need.
	const cancelRes = await fetch(
		`${baseUrl}${ACP_SERVERS_PATH}/${encodeURIComponent(server.serverId)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "session/cancel",
				params: { sessionId: record.agentSessionId },
			}),
		}
	);
	if (!cancelRes.ok) {
		const responseText = await cancelRes.text();
		throw new Error(
			`ACP session cancel failed: ${cancelRes.status} ${cancelRes.statusText} ${responseText}`
		);
	}

	log.info(
		{
			actorId: ctx.actorId,
			sessionId,
			agentSessionId: record.agentSessionId,
			serverId: server.serverId,
		},
		"cancelSession: success"
	);
}

async function getTranscript(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	offset: number,
	limit?: number
): Promise<SessionEvent[]> {
	const page = await ctx.vars.persist.listEvents({
		sessionId,
		cursor: offset > 0 ? String(offset) : undefined,
		limit,
	});
	return page.items;
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

function onSleep(): Promise<void> {
	return Promise.resolve();
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
	getTranscript: (
		ctx: SpaceRuntimeContext,
		sessionId: string,
		offset: number,
		limit?: number
	) => Promise<SessionEvent[]>;
	listAgents: (ctx: SpaceRuntimeContext) => Promise<AgentListResponse>;
};

type SessionDriver = TabDriverLifecycle<SessionPublicActions> & {
	publicActions: SessionPublicActions;
};

export const sessionDriver: SessionDriver = {
	kind: "session",
	onSleep,
	listTabs,
	publicActions: {
		sendMessage,
		ingestTurnRunnerBatch,
		cancelSession,
		getTranscript,
		listAgents,
	},
};
