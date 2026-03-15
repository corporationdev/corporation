import { DurableObject } from "cloudflare:workers";
import type {
	SessionStreamFrame,
	SessionStreamState,
} from "@tendril/contracts/browser-do";
import { sessionEventSchema } from "@tendril/contracts/browser-do";
import type {
	AbortSessionInput,
	CreateSessionInput,
	CreateSessionResult,
	GetSessionInput,
	PromptSessionInput,
	RespondToPermissionInput,
	SpaceSessionRow,
} from "@tendril/contracts/browser-space";
import type {
	EnvironmentRpcErrorCode,
	EnvironmentRpcResult,
	EnvironmentStreamDelivery,
	EnvironmentStreamDeliveryAck,
} from "@tendril/contracts/environment-do";
import type { EnvironmentRuntimeCommandResponse } from "@tendril/contracts/environment-runtime";
import { eq, isNull } from "drizzle-orm";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { getEnvironmentStub } from "../environment-do/stub";
import bundledMigrations from "./db/migrations";
import {
	type RuntimeEventRow,
	runtimeEvents,
	schema,
	sessions,
} from "./db/schema";

export type {
	RuntimeEventRow,
	SpaceSessionRow as SessionRow,
} from "./db/schema";

const NUMERIC_OFFSET_PATTERN = /^\d+$/;
const DEFAULT_STREAM_LIMIT = 200;
const MAX_STREAM_LIMIT = 500;
const DEFAULT_STREAM_TIMEOUT_MS = 25_000;
const MAX_STREAM_TIMEOUT_MS = 60_000;

function okResult<T>(value: T): EnvironmentRpcResult<T> {
	return {
		ok: true,
		value,
	};
}

function errorResult(
	code: EnvironmentRpcErrorCode,
	message: string
): EnvironmentRpcResult<never> {
	return {
		ok: false,
		error: {
			code,
			message,
		},
	};
}

function getRuntimeCommandError(
	response: EnvironmentRuntimeCommandResponse
): string | null {
	if (response.ok) {
		return null;
	}
	return response.error;
}

function createSessionErrorResult(message: string): CreateSessionResult {
	return {
		ok: false,
		error: {
			message,
		},
	};
}

function parseOffsetSequence(offset: string): number | null {
	if (offset === "-1" || offset === "now") {
		return null;
	}

	if (!NUMERIC_OFFSET_PATTERN.test(offset)) {
		return null;
	}

	return Number(offset);
}

function getEventPayload(event: unknown): Record<string, unknown> | null {
	if (event && typeof event === "object" && !Array.isArray(event)) {
		return event as Record<string, unknown>;
	}

	return null;
}

function getEventKind(payload: Record<string, unknown>): string {
	return typeof payload.kind === "string" ? payload.kind : "unknown";
}

function getOptionalString(
	payload: Record<string, unknown>,
	key: string
): string | null {
	return typeof payload[key] === "string" ? (payload[key] as string) : null;
}

function compareOffsets(left: string, right: string): number {
	const leftSeq = left === "-1" ? -1 : parseOffsetSequence(left);
	const rightSeq = right === "-1" ? -1 : parseOffsetSequence(right);
	if (leftSeq === null || rightSeq === null) {
		return left.localeCompare(right);
	}
	return leftSeq - rightSeq;
}

function normalizeLimit(limit?: number): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_STREAM_LIMIT;
	}
	return Math.min(
		MAX_STREAM_LIMIT,
		Math.max(1, Math.trunc(limit ?? DEFAULT_STREAM_LIMIT))
	);
}

function normalizeTimeoutMs(timeoutMs?: number): number {
	if (!Number.isFinite(timeoutMs)) {
		return DEFAULT_STREAM_TIMEOUT_MS;
	}
	return Math.min(
		MAX_STREAM_TIMEOUT_MS,
		Math.max(100, Math.trunc(timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS))
	);
}

function normalizeAfterOffset(afterOffset?: number): number {
	if (!Number.isFinite(afterOffset)) {
		return -1;
	}
	return Math.max(-1, Math.trunc(afterOffset ?? -1));
}

function mapRuntimeEventRowToFrame(
	row: Pick<RuntimeEventRow, "eventId" | "offsetSeq" | "createdAt" | "payload">
): SessionStreamFrame | null {
	const parsed = sessionEventSchema.safeParse(row.payload);
	if (!parsed.success) {
		console.warn("[space-do] sessionEventSchema parse failed", {
			offsetSeq: row.offsetSeq,
			error: parsed.error.message,
		});
		return null;
	}

	return {
		kind: "event",
		offset: row.offsetSeq,
		eventId: row.eventId,
		createdAt: row.createdAt,
		event: parsed.data,
	};
}

export class SpaceDurableObject extends DurableObject<Env> {
	private readonly ready: Promise<void>;
	private readonly sessionStreamWaiters = new Map<string, Set<() => void>>();
	private db!: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ready = this.initialize();
		ctx.blockConcurrencyWhile(async () => {
			await this.ready;
		});
	}

	private async initialize(): Promise<void> {
		this.db = drizzle(this.ctx.storage, { schema });
		await migrate(this.db, bundledMigrations);
	}

	protected async getDb(): Promise<DrizzleSqliteDODatabase<typeof schema>> {
		await this.ready;
		return this.db;
	}

	private async getPersistedSession(
		sessionId: string
	): Promise<SpaceSessionRow | null> {
		const db = await this.getDb();
		return (
			(await db.query.sessions.findFirst({
				where: eq(sessions.id, sessionId),
			})) ?? null
		);
	}

	private async getSessionOrThrow(sessionId: string): Promise<SpaceSessionRow> {
		const session = await this.getPersistedSession(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} was not found`);
		}
		return session;
	}

	private async sendEnvironmentCommand(
		clientId: string,
		command: Parameters<
			ReturnType<typeof getEnvironmentStub>["sendRuntimeCommand"]
		>[0]
	): Promise<EnvironmentRuntimeCommandResponse> {
		const environment = getEnvironmentStub(this.env.ENVIRONMENT_DO, clientId);
		const commandResult = await environment.sendRuntimeCommand(command);
		if (!commandResult.ok) {
			throw new Error(commandResult.error.message);
		}
		const runtimeError = getRuntimeCommandError(commandResult.value.response);
		if (runtimeError) {
			throw new Error(runtimeError);
		}
		return commandResult.value.response;
	}

	async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
		const db = await this.getDb();
		const now = Date.now();
		const streamKey = `session:${input.sessionId}`;

		await db
			.insert(sessions)
			.values({
				id: input.sessionId,
				clientId: input.clientId,
				streamKey,
				title: input.title ?? "New Chat",
				agent: input.agent,
				cwd: input.cwd,
				model: input.model,
				mode: input.mode,
				configOptions: input.configOptions ?? null,
				lastAppliedOffset: "-1",
				lastEventAt: null,
				lastSyncError: null,
				createdAt: now,
				updatedAt: now,
				archivedAt: null,
			})
			.onConflictDoUpdate({
				target: sessions.id,
				set: {
					clientId: input.clientId,
					streamKey,
					title: input.title ?? "New Chat",
					agent: input.agent,
					cwd: input.cwd,
					model: input.model,
					mode: input.mode,
					configOptions: input.configOptions ?? null,
					updatedAt: now,
				},
			});

		const environment = getEnvironmentStub(
			this.env.ENVIRONMENT_DO,
			input.clientId
		);

		const commandResult = await environment.sendRuntimeCommand({
			type: "create_session",
			requestId: crypto.randomUUID(),
			input: {
				sessionId: input.sessionId,
				agent: input.agent,
				cwd: input.cwd,
				model: input.model,
				mode: input.mode,
				configOptions: input.configOptions,
			},
		});
		if (!commandResult.ok) {
			const [runtimeState, runtimeConnections] = await Promise.all([
				environment.hasConnectedRuntime(),
				environment.getRuntimeConnectionsSnapshot(),
			]);
			console.error("space-do.createSession.sendRuntimeCommand.failed", {
				spaceName: input.spaceName,
				sessionId: input.sessionId,
				clientId: input.clientId,
				error: commandResult.error.message,
				hasConnectedRuntime: runtimeState.ok
					? runtimeState.value.connected
					: null,
				runtimeConnections: runtimeConnections.ok
					? runtimeConnections.value.snapshot
					: null,
			});
			await db
				.update(sessions)
				.set({
					lastSyncError: commandResult.error.message,
					updatedAt: Date.now(),
				})
				.where(eq(sessions.id, input.sessionId));
			return createSessionErrorResult(commandResult.error.message);
		}

		const commandError = getRuntimeCommandError(commandResult.value.response);
		if (commandError) {
			await db
				.update(sessions)
				.set({
					lastSyncError: commandError,
					updatedAt: Date.now(),
				})
				.where(eq(sessions.id, input.sessionId));
			return createSessionErrorResult(commandError);
		}

		const subscribeResult = await environment.subscribeStream({
			stream: streamKey,
			offset: "-1",
			subscriber: {
				requesterId: input.sessionId,
				callback: {
					binding: "SPACE_DO",
					name: input.spaceName,
				},
			},
		});
		if (!subscribeResult.ok) {
			console.error("space-do.createSession.subscribeStream.failed", {
				spaceName: input.spaceName,
				sessionId: input.sessionId,
				clientId: input.clientId,
				error: subscribeResult.error.message,
				streamKey,
			});
			await db
				.update(sessions)
				.set({
					lastSyncError: subscribeResult.error.message,
					updatedAt: Date.now(),
				})
				.where(eq(sessions.id, input.sessionId));
			return createSessionErrorResult(subscribeResult.error.message);
		}

		await db
			.update(sessions)
			.set({
				lastSyncError: null,
				updatedAt: Date.now(),
			})
			.where(eq(sessions.id, input.sessionId));

		const session = await db.query.sessions.findFirst({
			where: eq(sessions.id, input.sessionId),
		});
		if (!session) {
			return createSessionErrorResult(
				`Session ${input.sessionId} was not persisted`
			);
		}
		return {
			ok: true,
			value: {
				session,
			},
		};
	}

	async getSession(input: GetSessionInput): Promise<SpaceSessionRow | null> {
		await this.ready;
		return await this.getPersistedSession(input.sessionId);
	}

	async getSessionEvents(input: {
		sessionId: string;
	}): Promise<RuntimeEventRow[]> {
		await this.ready;
		const db = await this.getDb();
		return await db.query.runtimeEvents.findMany({
			where: eq(runtimeEvents.sessionId, input.sessionId),
			orderBy: (table, { asc }) => [asc(table.offsetSeq)],
		});
	}

	async listSessions(): Promise<SpaceSessionRow[]> {
		await this.ready;
		const db = await this.getDb();
		return await db.query.sessions.findMany({
			where: isNull(sessions.archivedAt),
			orderBy: (table, { desc }) => [desc(table.updatedAt)],
		});
	}

	async promptSession(input: PromptSessionInput): Promise<null> {
		await this.ready;
		const session = await this.getSessionOrThrow(input.sessionId);
		await this.sendEnvironmentCommand(session.clientId, {
			type: "prompt",
			requestId: crypto.randomUUID(),
			input: {
				sessionId: input.sessionId,
				prompt: input.prompt,
				model: input.model,
				mode: input.mode,
				configOptions: input.configOptions,
			},
		});
		return null;
	}

	async abortSession(input: AbortSessionInput): Promise<boolean> {
		await this.ready;
		const session = await this.getSessionOrThrow(input.sessionId);
		const response = await this.sendEnvironmentCommand(session.clientId, {
			type: "abort",
			requestId: crypto.randomUUID(),
			input: {
				sessionId: input.sessionId,
			},
		});
		if (!(response.ok && "aborted" in response.result)) {
			throw new Error("Unexpected abort response from runtime");
		}
		return response.result.aborted;
	}

	async respondToPermission(input: RespondToPermissionInput): Promise<boolean> {
		await this.ready;
		const session = await this.getSessionOrThrow(input.sessionId);
		const response = await this.sendEnvironmentCommand(session.clientId, {
			type: "respond_to_permission",
			requestId: crypto.randomUUID(),
			input: {
				requestId: input.requestId,
				outcome: input.outcome,
			},
		});
		if (!(response.ok && "handled" in response.result)) {
			throw new Error("Unexpected permission response from runtime");
		}
		return response.result.handled;
	}

	async getSessionStreamState(sessionId: string): Promise<SessionStreamState> {
		await this.ready;
		const session = await this.getPersistedSession(sessionId);
		const lastOffset = parseOffsetSequence(session?.lastAppliedOffset ?? "-1");

		if (!session) {
			return {
				sessionId,
				agent: null,
				modelId: null,
				lastOffset: 0,
			};
		}

		return {
			sessionId,
			agent: session.agent,
			modelId: session.model ?? null,
			lastOffset: Math.max(0, lastOffset ?? 0),
		};
	}

	private async readSessionFramesChunk(
		sessionId: string,
		afterOffset: number,
		limit: number
	): Promise<{
		frames: SessionStreamFrame[];
		nextOffset: number;
		upToDate: boolean;
		streamClosed: boolean;
	}> {
		const db = await this.getDb();
		const session = await this.getSessionOrThrow(sessionId);
		const sessionLastOffset =
			parseOffsetSequence(session.lastAppliedOffset) ?? -1;
		const rows = await db.query.runtimeEvents.findMany({
			where: (table, { and, eq, gt }) =>
				and(eq(table.sessionId, sessionId), gt(table.offsetSeq, afterOffset)),
			orderBy: (table, { asc }) => [asc(table.offsetSeq)],
			limit: limit + 1,
		});

		const hasMore = rows.length > limit;
		const taken = hasMore ? rows.slice(0, limit) : rows;
		const frames = taken
			.map((row) => mapRuntimeEventRowToFrame(row))
			.filter((frame): frame is SessionStreamFrame => frame !== null);
		const nextOffset =
			frames.at(-1)?.offset ?? Math.max(afterOffset, sessionLastOffset, 0);

		return {
			frames,
			nextOffset,
			upToDate: !hasMore,
			streamClosed: false,
		};
	}

	private createSessionStreamWaiter(
		sessionId: string,
		timeoutMs: number
	): {
		cancel: () => void;
		promise: Promise<void>;
	} {
		let settled = false;
		let resolvePromise!: () => void;

		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});

		const cleanup = () => {
			const waiters = this.sessionStreamWaiters.get(sessionId);
			if (!waiters) {
				return;
			}
			waiters.delete(wake);
			if (waiters.size === 0) {
				this.sessionStreamWaiters.delete(sessionId);
			}
		};

		const settle = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutHandle);
			cleanup();
			resolvePromise();
		};

		const wake = () => {
			settle();
		};

		const timeoutHandle = setTimeout(() => {
			settle();
		}, timeoutMs);

		const waiters = this.sessionStreamWaiters.get(sessionId);
		if (waiters) {
			waiters.add(wake);
		} else {
			this.sessionStreamWaiters.set(sessionId, new Set([wake]));
		}

		return {
			cancel: settle,
			promise,
		};
	}

	private notifySessionStreamWaiters(sessionId: string): void {
		const waiters = this.sessionStreamWaiters.get(sessionId);
		if (!waiters) {
			return;
		}

		this.sessionStreamWaiters.delete(sessionId);
		for (const wake of waiters) {
			wake();
		}
	}

	async readSessionStream(
		sessionId: string,
		afterOffset?: number,
		limit?: number,
		live?: boolean,
		timeoutMs?: number
	): Promise<{
		frames: SessionStreamFrame[];
		nextOffset: number;
		upToDate: boolean;
		streamClosed: boolean;
	}> {
		await this.ready;
		const normalizedAfterOffset = normalizeAfterOffset(afterOffset);
		const normalizedLimit = normalizeLimit(limit);
		const normalizedLive = live === true;
		const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);

		let result = await this.readSessionFramesChunk(
			sessionId,
			normalizedAfterOffset,
			normalizedLimit
		);
		if (!normalizedLive || result.frames.length > 0) {
			return result;
		}

		const waiter = this.createSessionStreamWaiter(
			sessionId,
			normalizedTimeoutMs
		);
		try {
			// Re-read after registering the waiter so we do not miss updates that
			// arrive between the initial empty read and waiter installation.
			result = await this.readSessionFramesChunk(
				sessionId,
				normalizedAfterOffset,
				normalizedLimit
			);
			if (result.frames.length > 0) {
				return result;
			}

			await waiter.promise;
			return await this.readSessionFramesChunk(
				sessionId,
				normalizedAfterOffset,
				normalizedLimit
			);
		} finally {
			waiter.cancel();
		}
	}

	receiveEnvironmentStreamItems(
		input: EnvironmentStreamDelivery
	): Promise<EnvironmentRpcResult<EnvironmentStreamDeliveryAck>> {
		return this.ingestEnvironmentStreamItems(input);
	}

	private async ingestEnvironmentStreamItems(
		input: EnvironmentStreamDelivery
	): Promise<EnvironmentRpcResult<EnvironmentStreamDeliveryAck>> {
		await this.ready;
		const db = await this.getDb();
		const nextOffsetSequence =
			input.nextOffset === "-1" ? -1 : parseOffsetSequence(input.nextOffset);
		if (nextOffsetSequence === null && input.nextOffset !== "-1") {
			console.error("[space-do] invalid next offset", input.nextOffset);
			return errorResult(
				"stream_invalid_payload",
				`Invalid next offset ${input.nextOffset}`
			);
		}

		const session = await db.query.sessions.findFirst({
			where: eq(sessions.id, input.requesterId),
		});
		if (!(session && session.streamKey === input.stream)) {
			console.error("[space-do] no session found for stream", {
				stream: input.stream,
				requesterId: input.requesterId,
				sessionFound: !!session,
				sessionStreamKey: session?.streamKey,
			});
			return errorResult(
				"stream_session_not_found",
				`No session found for stream ${input.stream}`
			);
		}
		console.log(
			"[space-do] ingesting",
			input.items.length,
			"events for session",
			session.id,
			"committedOffset will be >=",
			input.nextOffset
		);

		for (const item of input.items) {
			if (parseOffsetSequence(item.offset) === null) {
				return errorResult(
					"stream_invalid_payload",
					`Invalid event offset ${item.offset}`
				);
			}
			if (!getEventPayload(item.event)) {
				return errorResult(
					"stream_invalid_payload",
					`Invalid event payload for ${item.eventId}`
				);
			}
		}

		const lastEventAt =
			input.items.reduce<number | null>(
				(max, item) =>
					max === null ? item.createdAt : Math.max(max, item.createdAt),
				null
			) ?? session.lastEventAt;
		const committedOffset =
			compareOffsets(input.nextOffset, session.lastAppliedOffset) >= 0
				? input.nextOffset
				: session.lastAppliedOffset;

		await db.transaction(async (tx) => {
			if (input.items.length > 0) {
				await tx
					.insert(runtimeEvents)
					.values(
						input.items.map((item) => {
							const payload = getEventPayload(item.event);
							if (!payload) {
								throw new Error(`Invalid event payload for ${item.eventId}`);
							}
							const offsetSeq = parseOffsetSequence(item.offset);
							if (offsetSeq === null) {
								throw new Error(`Invalid event offset ${item.offset}`);
							}

							return {
								eventId: item.eventId,
								streamKey: input.stream,
								sessionId: session.id,
								offset: item.offset,
								offsetSeq,
								commandId: getOptionalString(payload, "commandId"),
								turnId: getOptionalString(payload, "turnId"),
								eventType: getEventKind(payload),
								createdAt: item.createdAt,
								payload,
							};
						})
					)
					.onConflictDoNothing();
			}

			await tx
				.update(sessions)
				.set({
					lastAppliedOffset: committedOffset,
					lastEventAt,
					lastSyncError: null,
					updatedAt: Date.now(),
				})
				.where(eq(sessions.id, session.id));
		});

		if (input.items.length > 0 || input.streamClosed) {
			this.notifySessionStreamWaiters(session.id);
		}

		return okResult({
			committedOffset,
		});
	}

	async fetch(_request: Request): Promise<Response> {
		await this.ready;
		return new Response("Not found", { status: 404 });
	}
}
