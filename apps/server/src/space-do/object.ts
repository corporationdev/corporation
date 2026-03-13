import { DurableObject } from "cloudflare:workers";
import type {
	EnvironmentRpcResult,
	EnvironmentStreamDelivery,
} from "@corporation/contracts/environment-do";
import type { EnvironmentRuntimeCommandResponse } from "@corporation/contracts/environment-runtime";
import type {
	CreateSessionInput,
	CreateSessionResult,
} from "@corporation/contracts/orpc/browser-space";
import { eq } from "drizzle-orm";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { getEnvironmentStub } from "../environment-do/stub";
import bundledMigrations from "./db/migrations";
import { schema, sessions } from "./db/schema";

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

	receiveEnvironmentStreamItems(
		input: EnvironmentStreamDelivery
	): EnvironmentRpcResult<{ committedOffset: string }> {
		return okResult({
			committedOffset: input.nextOffset,
		});
	}

	async fetch(_request: Request): Promise<Response> {
		await this.ready;
		return new Response("Not found", { status: 404 });
	}
}
