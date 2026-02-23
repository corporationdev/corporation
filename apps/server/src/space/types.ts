import type { Daytona, PtyHandle } from "@daytonaio/sdk";
import type { drizzle } from "drizzle-orm/durable-sqlite";
import type { SandboxAgent as SandboxAgentClient } from "sandbox-agent";

export type PersistedState = {
	sandboxUrl: string | null;
	sandboxId: string | null;
};

export type SpaceDatabase = ReturnType<typeof drizzle>;

export type SubscriptionHub = {
	channels: Map<string, Set<string>>;
	connToChannels: Map<string, Set<string>>;
};

export type SpaceVars = {
	db: SpaceDatabase;
	daytona: Daytona;
	sandboxClient: SandboxAgentClient | null;
	sessionStreams: Map<string, AbortController>;
	terminalHandles: Map<string, PtyHandle>;
	terminalBuffers: Map<string, number[]>;
	terminalPersistWrites: Map<string, Promise<void>>;
	subscriptions: SubscriptionHub;
};

export type ConnectionSender = {
	send: (eventName: string, ...args: unknown[]) => void;
};

export type SpaceRuntimeContext = {
	state: PersistedState;
	vars: SpaceVars;
	conns: Map<string, ConnectionSender>;
	waitUntil: (promise: Promise<void>) => void;
	broadcast: (eventName: string, ...args: unknown[]) => void;
	broadcastTabsChanged: () => Promise<void>;
	conn?: { id: string };
};
