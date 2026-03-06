import type { drizzle } from "drizzle-orm/durable-sqlite";
import type { CommandHandle, Sandbox } from "e2b";
import type { SessionEvent } from "./turn-runner/types";

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
	pendingSessionEventInserts: SessionEvent[];
	pendingSessionEventFlush: Promise<void> | null;
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
	broadcastTabsChanged: () => Promise<void>;
	conn?: { id: string };
};
