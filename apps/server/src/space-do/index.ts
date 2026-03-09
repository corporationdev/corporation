import acpAgents from "@corporation/config/acp-agent-manifest";
import type { AgentProbeResponse } from "@corporation/contracts/sandbox-do";
import { env } from "@corporation/env/server";
import { Sandbox } from "@e2b/desktop";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { actor } from "rivetkit";
import { ingestAgentRunnerBatch } from "./agent-runner";
import bundledMigrations from "./db/migrations";
import { type SessionRow, schema } from "./db/schema";
import { getDesktopStreamUrl } from "./desktop";
import { getSessionStreamState, readSessionStream } from "./session-stream";
import { cancelSession, listSessions, sendMessage } from "./sessions";
import {
	getTerminalSnapshot,
	input as terminalInput,
	resize as terminalResize,
} from "./terminal";
import type { PersistedState, SpaceVars } from "./types";

export type { SessionRow } from "./db/schema";

const SANDBOX_TIMEOUT_MS = 900_000;
const SANDBOX_KEEP_ALIVE_THROTTLE_MS = 240_000;
const SANDBOX_USER = "user";

function quoteShellArg(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function emptyAgentProbeResponse(status: "not_installed" | "error") {
	const agents = acpAgents
		.filter((agent) => agent.runtimeId)
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

async function getAgentProbeState(c: {
	state: PersistedState;
}): Promise<AgentProbeResponse> {
	if (!(c.state.agentUrl && c.state.workdir)) {
		return emptyAgentProbeResponse("not_installed");
	}

	try {
		const response = await fetch(`${c.state.agentUrl}/v1/agents/probe`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				ids: acpAgents
					.filter((agent) => agent.runtimeId)
					.map((agent) => agent.id),
				cwd: c.state.workdir,
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

export const space = actor({
	createState: (
		c,
		input: {
			agentUrl: string;
			sandboxId: string;
			workdir: string;
		}
	): PersistedState => {
		const spaceSlug = c.key[0];
		if (!spaceSlug) {
			throw new Error("Actor key must contain a spaceSlug");
		}

		return {
			agentUrl: input.agentUrl,
			sandboxId: input.sandboxId,
			workdir: input.workdir,
		};
	},

	createVars: async (c, driverCtx: DriverContext): Promise<SpaceVars> => {
		const db = drizzle(driverCtx.state.storage, { schema });

		await migrate(db, bundledMigrations);

		if (!env.E2B_API_KEY) {
			throw new Error("Missing E2B_API_KEY env var");
		}

		const sandbox = await Sandbox.connect(c.state.sandboxId, {
			apiKey: env.E2B_API_KEY,
		});

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

	onBeforeActionResponse: (_c, _name, _args, output) => {
		return output;
	},

	actions: {
		getAgentProbeState: (c) => getAgentProbeState(c),
		runCommand: async (
			c,
			command: string,
			background = false
		): Promise<void> => {
			if (!command.trim()) {
				throw new Error("Command cannot be empty");
			}

			const logId = crypto.randomUUID();
			const nextCommand = background
				? `nohup bash -lc ${quoteShellArg(command)} >/tmp/corporation-run-command-${logId}.log 2>&1 </dev/null &`
				: command;

			await c.vars.sandbox.commands.run(nextCommand, { user: SANDBOX_USER });
			console.info("Ran sandbox command");
		},
		listSessions: (c): Promise<SessionRow[]> => listSessions(c),
		sendMessage: (
			c,
			sessionId: string,
			content: string,
			agent: string,
			modelId: string
		) => sendMessage(c, sessionId, content, agent, modelId),
		ingestAgentRunnerBatch: (c, payload: unknown) =>
			ingestAgentRunnerBatch(c, payload),
		cancelSession: (c, sessionId: string) => cancelSession(c, sessionId),
		getSessionStreamState: (c, sessionId: string) =>
			getSessionStreamState(c, sessionId),
		readSessionStream: (
			c,
			sessionId: string,
			afterOffset?: number,
			limit?: number,
			live?: boolean,
			timeoutMs?: number
		) => readSessionStream(c, sessionId, afterOffset, limit, live, timeoutMs),
		getTerminalSnapshot: (c) => getTerminalSnapshot(c),
		input: (c, data: number[]) => terminalInput(c, data),
		resize: (c, cols: number, rows: number) => terminalResize(c, cols, rows),
		getDesktopStreamUrl: (c) => getDesktopStreamUrl(c),
		keepAliveSandbox: async (c): Promise<void> => {
			const now = Date.now();
			if (
				now - c.vars.lastSandboxKeepAliveAt <
				SANDBOX_KEEP_ALIVE_THROTTLE_MS
			) {
				return;
			}

			await c.vars.sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
			c.vars.lastSandboxKeepAliveAt = now;
		},
	},
});
