import { DurableObject } from "cloudflare:workers";
import type {
	EnvironmentRpcErrorCode,
	EnvironmentRpcResult,
	EnvironmentStreamDelivery,
	EnvironmentStreamDeliveryAck,
} from "@corporation/contracts/environment-do";
import type { EnvironmentRuntimeCommandResponse } from "@corporation/contracts/environment-runtime";
import type {
	CreateSessionInput,
	CreateSessionResult,
	GetSessionInput,
	PromptSessionInput,
	AbortSessionInput,
	RespondToPermissionInput,
	SpaceSessionRow,
} from "@corporation/contracts/browser-space";
import { eq } from "drizzle-orm";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { getEnvironmentStub } from "../environment-do/stub";
import bundledMigrations from "./db/migrations";
import { runtimeEvents, schema, sessions } from "./db/schema";

export type {
	RuntimeEventRow,
	SpaceSessionRow as SessionRow,
} from "./db/schema";

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

	if (!/^\d+$/.test(offset)) {
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

function getEventType(payload: Record<string, unknown>): string {
	return typeof payload.type === "string" ? payload.type : "unknown";
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

export class SpaceDurableObject extends DurableObject<Env> {
	private readonly ready: Promise<void>;
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
		environmentId: string,
		command: Parameters<
			ReturnType<typeof getEnvironmentStub>["sendRuntimeCommand"]
		>[0]
	): Promise<EnvironmentRuntimeCommandResponse> {
		const environment = getEnvironmentStub(this.env.ENVIRONMENT_DO, environmentId);
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
				environmentId: input.environmentId,
				streamKey,
				title: input.title ?? "New Chat",
				agent: input.agent,
				cwd: input.cwd,
				model: input.model,
				mode: input.mode,
				configOptions: input.configOptions ?? null,
				syncStatus: "pending",
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
					environmentId: input.environmentId,
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
			input.environmentId
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
			await db
				.update(sessions)
				.set({
					syncStatus: "error",
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
					syncStatus: "error",
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
			await db
				.update(sessions)
				.set({
					syncStatus: "error",
					lastSyncError: subscribeResult.error.message,
					updatedAt: Date.now(),
				})
				.where(eq(sessions.id, input.sessionId));
			return createSessionErrorResult(subscribeResult.error.message);
		}

		await db
			.update(sessions)
			.set({
				syncStatus: "live",
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

	async promptSession(input: PromptSessionInput): Promise<null> {
		await this.ready;
		const session = await this.getSessionOrThrow(input.sessionId);
		await this.sendEnvironmentCommand(session.environmentId, {
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
		const response = await this.sendEnvironmentCommand(session.environmentId, {
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
		const response = await this.sendEnvironmentCommand(session.environmentId, {
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
			return errorResult(
				"stream_invalid_payload",
				`Invalid next offset ${input.nextOffset}`
			);
		}

		const session = await db.query.sessions.findFirst({
			where: eq(sessions.id, input.requesterId),
		});
		if (!(session && session.streamKey === input.stream)) {
			return errorResult(
				"stream_session_not_found",
				`No session found for stream ${input.stream}`
			);
		}

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
								eventType: getEventType(payload),
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
					syncStatus: "live",
					updatedAt: Date.now(),
				})
				.where(eq(sessions.id, session.id));
		});

		return okResult({
			committedOffset,
		});
	}

	async fetch(_request: Request): Promise<Response> {
		await this.ready;
		return new Response("Not found", { status: 404 });
	}
}
