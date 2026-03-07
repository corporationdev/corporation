import { env } from "@corporation/env/server";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Sandbox } from "e2b";
import { actor } from "rivetkit";
import bundledMigrations from "../db/migrations/migrations";
import { type SessionRow, schema } from "../db/schema";
import { ingestAgentRunnerBatch } from "./agent-runner";
import { getSessionStreamState, readSessionStream } from "./session-stream";
import { cancelSession, listSessions, sendMessage } from "./sessions";
import {
	getTerminalSnapshot,
	input as terminalInput,
	resize as terminalResize,
} from "./terminal";
import type { PersistedState, SpaceVars } from "./types";

export type { SessionRow } from "../db/schema";

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
		};

		return vars;
	},

	onBeforeActionResponse: (_c, _name, _args, output) => {
		return output;
	},

	actions: {
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
	},
});
