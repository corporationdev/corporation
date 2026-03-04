import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { AgentListResponse, Session, SessionEvent } from "sandbox-agent";
import { type SessionTab, sessions, tabs } from "../db/schema";
import { createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import {
	ensureNoRunningTurn,
	ingestTurnRunnerBatch,
	startTurnRunner,
} from "./turn-runner";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_SESSION_TITLE = "New Chat";
const AUTO_BRANCH_NAME_ENDPOINT = "/internal/auto-branch-name";
const ACP_SERVERS_PATH = "/v1/acp";
const TRAILING_SLASH_RE = /\/$/;
const log = createLogger("space:session");

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

	await ensureNoRunningTurn(ctx, sessionId);

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

	await startTurnRunner(ctx, {
		sessionId,
		content,
		agent,
		modelId,
	});
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
	listTabs,
	publicActions: {
		sendMessage,
		ingestTurnRunnerBatch,
		cancelSession,
		getTranscript,
		listAgents,
	},
};
