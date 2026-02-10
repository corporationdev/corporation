import type { AgentSessionRow, SessionEventRow } from "../main/db/schema";

export type AgentSessionRecord = AgentSessionRow;
export type CachedEventRecord = SessionEventRow;

export type LocalCacheApi = {
	sessions: {
		getAll: () => Promise<AgentSessionRecord[]>;
		replaceAll: (sessions: AgentSessionRecord[]) => Promise<void>;
	};
	events: {
		getForSession: (sessionId: string) => Promise<CachedEventRecord[]>;
		appendMany: (events: CachedEventRecord[]) => Promise<void>;
	};
};
