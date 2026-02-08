export type AgentSession = {
	id: string;
	title: string;
	userId: string;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
};

export type CachedEvent = {
	sessionId: string;
	sequence: number;
	eventType: string;
	data: string; // JSON-serialized UniversalEvent
};

export type LocalCacheApi = {
	sessions: {
		getAll: () => AgentSession[];
		getById: (id: string) => AgentSession | null;
		replaceAll: (sessions: AgentSession[]) => void;
		upsert: (session: AgentSession) => void;
	};
	events: {
		getForSession: (sessionId: string) => CachedEvent[];
		appendMany: (events: CachedEvent[]) => void;
		deleteForSession: (sessionId: string) => void;
	};
};
