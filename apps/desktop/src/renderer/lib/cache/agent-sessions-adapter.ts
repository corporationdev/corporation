import type { Doc, Id } from "@corporation/backend/convex/_generated/dataModel";
import type { AgentSessionRecord } from "../../../shared/ipc-api";

export const AGENT_SESSIONS_CACHE_KEY = "convex:agentSessions.list:{}";

export type ConvexAgentSession = Doc<"agentSessions">;

export function convexSessionToRecord(
	session: ConvexAgentSession
): AgentSessionRecord {
	return {
		id: session._id,
		title: session.title,
		userId: session.userId,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		archivedAt: session.archivedAt,
	};
}

function recordToConvexSession(record: AgentSessionRecord): ConvexAgentSession {
	return {
		_id: record.id as Id<"agentSessions">,
		_creationTime: record.createdAt,
		title: record.title,
		userId: record.userId,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		archivedAt: record.archivedAt,
	};
}

export async function readCachedAgentSessions(): Promise<ConvexAgentSession[]> {
	const rows = await window.localCache.sessions.getAll();
	return rows.map(recordToConvexSession);
}

export async function writeCachedAgentSessions(
	remoteSessions: ConvexAgentSession[]
): Promise<void> {
	await window.localCache.sessions.replaceAll(
		remoteSessions.map(convexSessionToRecord)
	);
}
