import acpAgents from "@corporation/config/acp-agent-manifest";
import type { AgentProbeResponse } from "@corporation/contracts/sandbox-do";
import { env } from "@corporation/env/server";
import { Sandbox } from "@e2b/desktop";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { actor } from "rivetkit";
import {
	createActorAuthState,
	createRuntimeAuthHeaders,
	requireActorAuth,
} from "./actor-auth";
import { ingestAgentRunnerBatch } from "./agent-runner";
import bundledMigrations from "./db/migrations";
import { type SessionRow, schema } from "./db/schema";
import { getDesktopStreamUrl } from "./desktop";
import { requireSandbox } from "./sandbox";
import { keepAliveSandbox } from "./sandbox-keep-alive";
import { getSessionStreamState, readSessionStream } from "./session-stream";
import { cancelSession, listSessions, sendMessage } from "./sessions";
import {
	broadcastTerminalSnapshot,
	getTerminalSnapshot,
	resetTerminal,
	runCommandInTerminal,
	input as terminalInput,
	resize as terminalResize,
} from "./terminal";
import type {
	PersistedState,
	SandboxBinding,
	SpaceConnectionParams,
	SpaceRuntimeContext,
	SpaceVars,
} from "./types";

export type { SessionRow } from "./db/schema";

const SANDBOX_USER = "user";
const KEEP_ALIVE_ACTIONS = new Set([
	"getDesktopStreamUrl",
	"ingestAgentRunnerBatch",
	"input",
	"keepAliveSandbox",
	"runCommand",
	"sendMessage",
]);

function createEmptyState(): PersistedState {
	return {
		binding: null,
	};
}

async function connectSandbox(
	sandboxId: string | null
): Promise<Sandbox | null> {
	if (!sandboxId) {
		return null;
	}

	return await Sandbox.connect(sandboxId, {
		apiKey: env.E2B_API_KEY,
	});
}

function sameBinding(
	current: SandboxBinding | null,
	next: SandboxBinding | null
): boolean {
	if (current === null && next === null) {
		return true;
	}
	if (current === null || next === null) {
		return false;
	}
	return (
		current.sandboxId === next.sandboxId && current.agentUrl === next.agentUrl
	);
}

function quoteShellArg(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function emptyAgentProbeResponse(status: "not_installed" | "error") {
	const agents = acpAgents
		.filter((agent) => agent.runtimeCommand)
		.map((agent) => ({
			id: agent.id,
			name: agent.name,
			status,
			configOptions: null,
			verifiedAt: null,
			authCheckedAt: Date.now(),
			error: status === "error" ? "Unable to reach sandbox runtime" : null,
		}));

	return {
		probedAt: Date.now(),
		agents,
	} satisfies AgentProbeResponse;
}

async function getAgentProbeState(
	c: Pick<SpaceRuntimeContext, "state" | "conn">
): Promise<AgentProbeResponse> {
	const binding = c.state.binding;
	if (!binding) {
		return emptyAgentProbeResponse("not_installed");
	}
	const { authToken } = requireActorAuth(c);

	try {
		const response = await fetch(`${binding.agentUrl}/v1/agents/probe`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...createRuntimeAuthHeaders(authToken),
			},
			body: JSON.stringify({
				ids: acpAgents
					.filter((agent) => agent.runtimeCommand)
					.map((agent) => agent.id),
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(
				`sandbox-runtime agent probe failed (${response.status}): ${text}`
			);
		}

		return (await response.json()) as AgentProbeResponse;
	} catch (error) {
		console.error("Failed to fetch agent probe state", error);
		return emptyAgentProbeResponse("error");
	}
}

function asSpaceRuntimeContext(c: unknown): SpaceRuntimeContext {
	return c as SpaceRuntimeContext;
}

async function syncSandboxBinding(
	c: SpaceRuntimeContext,
	binding: SandboxBinding | null
): Promise<boolean> {
	if (sameBinding(c.state.binding, binding)) {
		return false;
	}

	const sandbox = await connectSandbox(binding?.sandboxId ?? null);

	await resetTerminal(c);

	c.state.binding = binding;
	c.vars.sandbox = sandbox;
	c.vars.lastSandboxKeepAliveAt = 0;

	if (c.vars.sandbox && c.conns.size > 0) {
		try {
			await broadcastTerminalSnapshot(c);
		} catch (error) {
			console.error("Failed to broadcast terminal snapshot after sync", error);
		}
	}

	return true;
}
export const space = actor({
	createState: () => createEmptyState(),
	createConnState: async (_c, params: SpaceConnectionParams) => {
		return await createActorAuthState(params);
	},

	createVars: async (c, driverCtx: DriverContext): Promise<SpaceVars> => {
		const db = drizzle(driverCtx.state.storage, { schema });

		await migrate(db, bundledMigrations);

		if (!env.E2B_API_KEY) {
			throw new Error("Missing E2B_API_KEY env var");
		}

		let sandbox: Sandbox | null = null;
		try {
			sandbox = await connectSandbox(c.state.binding?.sandboxId ?? null);
		} catch (error) {
			console.warn("Failed to connect sandbox for space actor", {
				actorId: c.actorId,
				sandboxId: c.state.binding?.sandboxId ?? null,
				error,
			});
		}

		const vars: SpaceVars = {
			db,
			sandbox,
			terminalHandles: new Map(),
			sessionStreamWaiters: new Map(),
			agentRunnerSequenceBySessionId: new Map(),
			lastSandboxKeepAliveAt: 0,
		};

		return vars;
	},

	onBeforeActionResponse: async (c, name, _args, output) => {
		if (KEEP_ALIVE_ACTIONS.has(name)) {
			await keepAliveSandbox(asSpaceRuntimeContext(c));
		}

		return output;
	},
	actions: {
		getAgentProbeState: (c) => getAgentProbeState(c),
		syncSandboxBinding: (c, binding: SandboxBinding | null) =>
			syncSandboxBinding(asSpaceRuntimeContext(c), binding),
		runCommand: async (
			c,
			command: string,
			background = false
		): Promise<void> => {
			const ctx = asSpaceRuntimeContext(c);
			if (!command.trim()) {
				throw new Error("Command cannot be empty");
			}

			if (!background) {
				await runCommandInTerminal(ctx, command);
				return;
			}

			const logId = crypto.randomUUID();
			const nextCommand = `nohup bash -lc ${quoteShellArg(command)} >/tmp/corporation-run-command-${logId}.log 2>&1 </dev/null &`;

			await requireSandbox(ctx).commands.run(nextCommand, {
				user: SANDBOX_USER,
			});
			console.info("Ran sandbox command");
		},
		listSessions: (c): Promise<SessionRow[]> =>
			listSessions(asSpaceRuntimeContext(c)),
		sendMessage: (
			c,
			sessionId: string,
			content: string,
			agent: string,
			modelId: string
		) =>
			sendMessage(asSpaceRuntimeContext(c), sessionId, content, agent, modelId),
		ingestAgentRunnerBatch: (c, payload: unknown) =>
			ingestAgentRunnerBatch(asSpaceRuntimeContext(c), payload),
		cancelSession: (c, sessionId: string) =>
			cancelSession(asSpaceRuntimeContext(c), sessionId),
		getSessionStreamState: (c, sessionId: string) =>
			getSessionStreamState(asSpaceRuntimeContext(c), sessionId),
		readSessionStream: (
			c,
			sessionId: string,
			afterOffset?: number,
			limit?: number,
			live?: boolean,
			timeoutMs?: number
		) =>
			readSessionStream(
				asSpaceRuntimeContext(c),
				sessionId,
				afterOffset,
				limit,
				live,
				timeoutMs
			),
		getTerminalSnapshot: (c) => getTerminalSnapshot(asSpaceRuntimeContext(c)),
		input: (c, data: number[]) => terminalInput(asSpaceRuntimeContext(c), data),
		resize: (c, cols: number, rows: number) =>
			terminalResize(asSpaceRuntimeContext(c), cols, rows),
		getDesktopStreamUrl: (c) => getDesktopStreamUrl(asSpaceRuntimeContext(c)),
		keepAliveSandbox: async (): Promise<void> => {},
	},
});
