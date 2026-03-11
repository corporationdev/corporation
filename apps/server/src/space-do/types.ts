import type { Sandbox } from "@e2b/desktop";
import type { drizzle } from "drizzle-orm/durable-sqlite";
import type { CommandHandle } from "e2b";
import type { JWTPayload } from "../auth";

export const SANDBOX_WORKDIR = "/workspace";

export type SandboxBinding = {
	sandboxId: string;
	agentUrl: string;
};

export type PersistedState = {
	binding: SandboxBinding | null;
};

export type SpaceDatabase = ReturnType<typeof drizzle>;

export type SpaceConnectionState = {
	authToken: string;
	jwtPayload: JWTPayload;
};

export type SpaceConnectionParams = {
	authToken: string;
};

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

export type BrowserConnection = ConnectionSender & {
	socket: WebSocket;
};

export type SpaceRuntimeContext = {
	actorId: string;
	key: string[];
	ctx: DurableObjectState;
	env: Env;
	state: PersistedState;
	vars: SpaceVars;
	conns: Map<string, BrowserConnection>;
	waitUntil: (promise: Promise<void>) => void;
	broadcast: (eventName: string, ...args: unknown[]) => void;
	conn?: { id: string; state: SpaceConnectionState };
};
