import type { SessionEventRow } from "../main/db/schema";

export type CachedEventRecord = SessionEventRow;

export type LocalCacheApi = {
	events: {
		getForSession: (sessionId: string) => Promise<CachedEventRecord[]>;
		appendMany: (events: CachedEventRecord[]) => Promise<void>;
	};
};
