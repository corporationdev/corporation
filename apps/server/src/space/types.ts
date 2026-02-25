import type { RivetPersistState } from "@sandbox-agent/persist-rivet";
import type { drizzle } from "drizzle-orm/durable-sqlite";
import type { CommandHandle, Sandbox } from "e2b";
import type { SandboxAgent as SandboxAgentClient } from "sandbox-agent";

export type PersistedState = RivetPersistState & {
	sandboxUrl: string | null;
	sandboxId: string | null;
};

export type SpaceDatabase = ReturnType<typeof drizzle>;

export type SubscriptionHub = {
	channels: Map<string, Set<string>>;
	connToChannels: Map<string, Set<string>>;
};

export type TerminalHandle = {
	sandbox: Sandbox;
	handle: CommandHandle;
};

export type SpaceVars = {
	db: SpaceDatabase;
	e2bApiKey: string;
	sandboxClient: SandboxAgentClient;
	sessionStreams: Map<string, () => void>;
	terminalHandles: Map<string, TerminalHandle>;
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
