import { and, asc, eq, gt } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
	SessionEvent,
	SessionStatus,
	SessionStreamFrame,
	SessionStreamFrameData,
	SessionStreamState,
} from "sandbox-runtime/schemas";
import { sessionStreamFrameDataSchema } from "sandbox-runtime/schemas";
import { sessionStreamFrames, sessions } from "./db/schema";
import type { SpaceRuntimeContext } from "./types";

const DEFAULT_STREAM_LIMIT = 200;
const MAX_STREAM_LIMIT = 500;
const DEFAULT_STREAM_TIMEOUT_MS = 25_000;
const MAX_STREAM_TIMEOUT_MS = 60_000;

type SessionStreamReadResult = {
	frames: SessionStreamFrame[];
	nextOffset: number;
	upToDate: boolean;
	streamClosed: boolean;
};

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

function mapFrameRowToFrame(row: {
	offset: number;
	data: unknown;
}): SessionStreamFrame | null {
	const parsedDataResult = sessionStreamFrameDataSchema.safeParse(row.data);
	if (!parsedDataResult.success) {
		return null;
	}

	const data = parsedDataResult.data;
	if (data.kind === "event") {
		return {
			kind: "event",
			offset: row.offset,
			event: data.event,
		};
	}

	if (data.kind === "status_changed") {
		return {
			kind: "status_changed",
			offset: row.offset,
			status: data.status,
			reason: data.reason,
		};
	}

	return null;
}

export function notifySessionStreamWaiters(
	ctx: SpaceRuntimeContext,
	sessionId: string
): void {
	const waiters = ctx.vars.sessionStreamWaiters.get(sessionId);
	if (!waiters) {
		return;
	}

	for (const wake of waiters) {
		wake();
	}
}

function waitForSessionStreamUpdate(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	timeoutMs: number
): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const waiters =
			ctx.vars.sessionStreamWaiters.get(sessionId) ?? new Set<() => void>();
		ctx.vars.sessionStreamWaiters.set(sessionId, waiters);

		const wake = () => {
			cleanup();
			resolve();
		};

		const cleanup = () => {
			if (settled) {
				return;
			}
			settled = true;
			waiters.delete(wake);
			if (waiters.size === 0) {
				ctx.vars.sessionStreamWaiters.delete(sessionId);
			}
			if (timer) {
				clearTimeout(timer);
			}
		};

		waiters.add(wake);
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, timeoutMs);
	});
}

async function readSessionFramesChunk(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	afterOffset: number,
	limit: number
): Promise<SessionStreamReadResult> {
	const [session] = await ctx.vars.db
		.select({
			lastOffset: sessions.lastStreamOffset,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	const sessionLastOffset = session?.lastOffset ?? 0;

	const rows = await ctx.vars.db
		.select({
			offset: sessionStreamFrames.offset,
			data: sessionStreamFrames.data,
		})
		.from(sessionStreamFrames)
		.where(
			and(
				eq(sessionStreamFrames.sessionId, sessionId),
				gt(sessionStreamFrames.offset, afterOffset)
			)
		)
		.orderBy(asc(sessionStreamFrames.offset))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const taken = hasMore ? rows.slice(0, limit) : rows;
	const frames: SessionStreamFrame[] = [];
	for (const row of taken) {
		const frame = mapFrameRowToFrame(row);
		if (frame) {
			frames.push(frame);
		}
	}

	const nextOffset =
		frames.at(-1)?.offset ?? Math.max(afterOffset, sessionLastOffset);
	return {
		frames,
		nextOffset,
		upToDate: !hasMore,
		streamClosed: false,
	};
}

export async function getSessionStreamState(
	ctx: SpaceRuntimeContext,
	sessionId: string
): Promise<SessionStreamState> {
	const [session] = await ctx.vars.db
		.select({
			status: sessions.status,
			agent: sessions.agent,
			modelId: sessions.modelId,
			lastOffset: sessions.lastStreamOffset,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!session) {
		return {
			sessionId,
			status: "idle",
			agent: null,
			modelId: null,
			lastOffset: 0,
		};
	}

	return {
		sessionId,
		status: session.status,
		agent: session.agent ?? null,
		modelId: session.modelId ?? null,
		lastOffset: session.lastOffset,
	};
}

export async function readSessionStream(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	afterOffset?: number,
	limit?: number,
	live?: boolean,
	timeoutMs?: number
): Promise<SessionStreamReadResult> {
	const normalizedAfterOffset = normalizeAfterOffset(afterOffset);
	const normalizedLimit = normalizeLimit(limit);
	const normalizedLive = live === true;
	const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);

	let result = await readSessionFramesChunk(
		ctx,
		sessionId,
		normalizedAfterOffset,
		normalizedLimit
	);

	if (!normalizedLive || result.frames.length > 0) {
		return result;
	}

	await waitForSessionStreamUpdate(ctx, sessionId, normalizedTimeoutMs);
	result = await readSessionFramesChunk(
		ctx,
		sessionId,
		normalizedAfterOffset,
		normalizedLimit
	);
	return result;
}

export function appendSessionEventFrames(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	events: SessionEvent[]
): void {
	if (events.length === 0) {
		return;
	}

	const inserted = ctx.vars.db.transaction((tx) => {
		const [session] = tx
			.select({
				lastOffset: sessions.lastStreamOffset,
			})
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
			.all();
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		let nextOffset = session.lastOffset;
		for (const event of events) {
			const candidateOffset = nextOffset + 1;
			const data: SessionStreamFrameData = { kind: "event", event };
			const inserted = tx
				.insert(sessionStreamFrames)
				.values({
					id: `${sessionId}:${candidateOffset}:${nanoid()}`,
					sessionId,
					offset: candidateOffset,
					createdAt: event.createdAt,
					kind: "event",
					eventId: event.id,
					data,
				})
				.onConflictDoNothing({
					target: [sessionStreamFrames.sessionId, sessionStreamFrames.eventId],
				})
				.returning({ id: sessionStreamFrames.id })
				.all();
			if (inserted.length > 0) {
				nextOffset = candidateOffset;
			}
		}

		if (nextOffset > session.lastOffset) {
			tx.update(sessions)
				.set({ lastStreamOffset: nextOffset })
				.where(eq(sessions.id, sessionId))
				.run();
		}
		return nextOffset > session.lastOffset;
	});

	if (inserted) {
		notifySessionStreamWaiters(ctx, sessionId);
	}
}

export function appendSessionStatusFrame(
	ctx: SpaceRuntimeContext,
	input: {
		sessionId: string;
		status: SessionStatus;
		reason?: string;
		createdAt?: number;
	}
): void {
	const inserted = ctx.vars.db.transaction((tx) => {
		const [session] = tx
			.select({
				lastOffset: sessions.lastStreamOffset,
			})
			.from(sessions)
			.where(eq(sessions.id, input.sessionId))
			.limit(1)
			.all();
		if (!session) {
			throw new Error(`Unknown session: ${input.sessionId}`);
		}

		const nextOffset = session.lastOffset + 1;
		const data: SessionStreamFrameData = {
			kind: "status_changed",
			status: input.status,
			reason: input.reason,
		};

		tx.insert(sessionStreamFrames)
			.values({
				id: `${input.sessionId}:${nextOffset}:${nanoid()}`,
				sessionId: input.sessionId,
				offset: nextOffset,
				createdAt: input.createdAt ?? Date.now(),
				kind: "status_changed",
				eventId: null,
				data,
			})
			.run();

		tx.update(sessions)
			.set({ lastStreamOffset: nextOffset })
			.where(eq(sessions.id, input.sessionId))
			.run();
		return true;
	});

	if (inserted) {
		notifySessionStreamWaiters(ctx, input.sessionId);
	}
}
