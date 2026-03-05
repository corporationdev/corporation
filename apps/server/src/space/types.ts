import type { drizzle } from "drizzle-orm/durable-sqlite";
import type { CommandHandle, Sandbox } from "e2b";
import type { SandboxAgent as SandboxAgentClient } from "sandbox-agent";
import type { SqliteSessionPersistDriver } from "../db/session-persist-driver";

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
	persist: SqliteSessionPersistDriver;
	sandbox: Sandbox;
	sandboxClient: SandboxAgentClient;
	terminalHandles: Map<string, CommandHandle>;
	terminalEnsures: Map<string, Promise<void>>;
	terminalOpenActions: Map<string, Promise<void>>;
	lastTerminalSnapshotAt: Map<string, number>;
	subscriptions: SubscriptionHub;
	lastTimeoutRefreshAt: number;
};

export type ConnectionSender = {
	send: (eventName: string, ...args: unknown[]) => void;
};

export type SpaceRuntimeContext = {
	actorId: string;
	state: PersistedState;
	vars: SpaceVars;
	conns: Map<string, ConnectionSender>;
	waitUntil: (promise: Promise<void>) => void;
	broadcast: (eventName: string, ...args: unknown[]) => void;
	broadcastTabsChanged: () => Promise<void>;
	conn?: { id: string };
};
