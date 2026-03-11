import type { RuntimeAccessTokenClaims } from "@corporation/contracts/runtime-auth";
import type {
	RuntimeCancelTurnMessage,
	RuntimeProbeAgentsMessage,
	RuntimeStartTurnMessage,
} from "@corporation/contracts/sandbox-do";
import type { Sandbox } from "@e2b/desktop";
import type { drizzle } from "drizzle-orm/durable-sqlite";
import type { JWTPayload } from "../auth";

export const SANDBOX_WORKDIR = "/workspace";

export type SandboxBinding = {
	sandboxId: string;
};

export type PersistedState = {
	binding: SandboxBinding | null;
};

export type SpaceDatabase = ReturnType<typeof drizzle>;

export type SpaceConnectionState = {
	authToken: string;
	jwtPayload: JWTPayload;
};

export type RuntimeConnectionAuthState = {
	authToken: string;
	claims: RuntimeAccessTokenClaims;
};

export type RuntimeCommandMetadata =
	| {
			type: "start_turn";
			commandId: string;
			sessionId: string;
			turnId: string;
	  }
	| {
			type: "cancel_turn";
			commandId: string;
			sessionId: string;
			turnId: string;
	  }
	| {
			type: "probe_agents";
			commandId: string;
	  };

export type SpaceConnectionParams = {
	authToken: string;
};

export type CommandHandle = Awaited<ReturnType<Sandbox["pty"]["create"]>>;

export type SpaceVars = {
	db: SpaceDatabase;
	sandbox: Sandbox | null;
	terminalHandles: Map<string, CommandHandle>;
	sessionStreamWaiters: Map<string, Set<() => void>>;
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
	runtime: {
		isConnected: () => boolean;
		send: (
			message:
				| RuntimeStartTurnMessage
				| RuntimeCancelTurnMessage
				| RuntimeProbeAgentsMessage,
			metadata: RuntimeCommandMetadata
		) => void;
	};
};
