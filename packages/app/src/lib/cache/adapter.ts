import type { SessionEventRow } from "./schema";

export type CachedEventRecord = SessionEventRow;

export type CacheAdapter = {
	events: {
		getForSession: (sessionId: string) => Promise<CachedEventRecord[]>;
		appendMany: (events: CachedEventRecord[]) => Promise<void>;
	};
};
