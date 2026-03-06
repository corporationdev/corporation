import type { drizzle } from "drizzle-orm/durable-sqlite";
import type { CommandHandle, Sandbox } from "e2b";

export type PersistedState = {
	agentUrl: string;
	sandboxId: string;
	workdir: string;
};

export type SpaceDatabase = ReturnType<typeof drizzle>;

export type SubscriptionHub = {
	channels: Map<string, Set<string>>;
	connToChannels: Map<string, Set<string>>;
};

export type SpaceVars = {
	db: SpaceDatabase;
	sandbox: Sandbox;
	terminalHandles: Map<string, CommandHandle>;
	terminalEnsures: Map<string, Promise<void>>;
	terminalOpenActions: Map<string, Promise<void>>;
	lastTerminalSnapshotAt: Map<string, number>;
	subscriptions: SubscriptionHub;
	lastTimeoutRefreshAt: number;
	agentRunnerSequenceBySessionId: Map<string, number>;
};

export type ConnectionSender = {
	send: (eventName: string, ...args: unknown[]) => void;
};

export type SpaceRuntimeContext = {
	actorId: string;
	key: string[];
	state: PersistedState;
	vars: SpaceVars;
	conns: Map<string, ConnectionSender>;
	waitUntil: (promise: Promise<void>) => void;
	broadcast: (eventName: string, ...args: unknown[]) => void;
	conn?: { id: string };
};
