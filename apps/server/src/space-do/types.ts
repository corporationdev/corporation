import type { Sandbox } from "@e2b/desktop";
import type { drizzle } from "drizzle-orm/durable-sqlite";
import type { CommandHandle } from "e2b";

export type SandboxBinding = {
	agentUrl: string;
	sandboxId: string;
	workdir: string;
};

export type PersistedState = {
	binding: SandboxBinding | null;
};

export type SpaceDatabase = ReturnType<typeof drizzle>;

export type SpaceVars = {
	db: SpaceDatabase;
	sandbox: Sandbox | null;
	terminalHandles: Map<string, CommandHandle>;
	sessionStreamWaiters: Map<string, Set<() => void>>;
	agentRunnerSequenceBySessionId: Map<string, number>;
	lastSandboxKeepAliveAt: number;
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
