import type {
	EnvironmentRuntimeCommand as RuntimeWebSocketCommand,
	EnvironmentRuntimeCommandResponse as RuntimeWebSocketResponse,
} from "@corporation/contracts/environment-runtime";
import { and, eq, gte, sql } from "drizzle-orm";
import type { RuntimeDatabase } from "./db";
import {
	type RuntimeCommandReceiptRow,
	type RuntimeEventLogRow,
	runtimeCommandReceipts,
	runtimeEventLog,
} from "./db/schema";
import type { RuntimeEvent } from "./runtime-events";
export type RuntimeEventEnvelope = {
	commandId?: string;
	createdAt: number;
	event: RuntimeEvent;
	eventId: string;
	offset: string;
	streamKey: string;
};

export type RuntimeCommandDuplicateState =
	| {
			kind: "new";
	  }
	| {
			kind: "duplicate";
			receipt: RuntimeCommandReceiptRow;
	  };

type CommandResultRecord = RuntimeWebSocketResponse extends infer Response
	? Response extends { ok: true; result: infer Result }
		? Result
		: never
	: never;

export function getCommandId(command: RuntimeWebSocketCommand): string {
	return command.requestId;
}

export function getStreamKeyForCommand(
	command: RuntimeWebSocketCommand
): string {
	switch (command.type) {
		case "create_session":
		case "prompt":
		case "abort":
			return `session:${command.input.sessionId}`;
		case "respond_to_permission":
			return `permission:${command.input.requestId}`;
		default: {
			const exhaustiveCheck: never = command;
			throw new Error(
				`Unsupported websocket runtime command: ${JSON.stringify(exhaustiveCheck)}`
			);
		}
	}
}

export function getStreamKeyForEvent(event: RuntimeEvent): string {
	return `session:${event.sessionId}`;
}

export type RuntimeStreamOffset = string;

export const STREAM_START_OFFSET = "-1";
export const STREAM_NOW_OFFSET = "now";

function parseStoredOffset(offset: RuntimeStreamOffset): number {
	if (offset === STREAM_START_OFFSET) {
		return -1;
	}
	if (offset === STREAM_NOW_OFFSET) {
		throw new Error('"now" is only valid for subscribe requests');
	}
	const parsed = Number.parseInt(offset, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid stream offset: ${offset}`);
	}
	return parsed;
}

function formatStoredOffset(sequence: number): RuntimeStreamOffset {
	return String(sequence);
}

export class RuntimeMessageStore {
	constructor(private readonly db: RuntimeDatabase) {}

	beginCommand(command: RuntimeWebSocketCommand): RuntimeCommandDuplicateState {
		const now = Date.now();
		const commandId = getCommandId(command);
		const streamKey = getStreamKeyForCommand(command);
		const existing = this.getCommandReceipt(commandId);
		if (existing) {
			return {
				kind: "duplicate",
				receipt: existing,
			};
		}

		this.db
			.insert(runtimeCommandReceipts)
			.values({
				commandId,
				streamKey,
				commandType: command.type,
				status: "accepted",
				input: command,
				createdAt: now,
				updatedAt: now,
			})
			.run();

		return { kind: "new" };
	}

	getCommandReceipt(commandId: string): RuntimeCommandReceiptRow | null {
		return (
			this.db
				.select()
				.from(runtimeCommandReceipts)
				.where(eq(runtimeCommandReceipts.commandId, commandId))
				.limit(1)
				.get() ?? null
		);
	}

	completeCommand(commandId: string, result: CommandResultRecord): void {
		this.db
			.update(runtimeCommandReceipts)
			.set({
				status: "completed",
				result,
				error: null,
				updatedAt: Date.now(),
			})
			.where(eq(runtimeCommandReceipts.commandId, commandId))
			.run();
	}

	failCommand(commandId: string, error: string): void {
		this.db
			.update(runtimeCommandReceipts)
			.set({
				status: "failed",
				error,
				updatedAt: Date.now(),
			})
			.where(eq(runtimeCommandReceipts.commandId, commandId))
			.run();
	}

	appendEvent(input: {
		commandId?: string;
		event: RuntimeEvent;
	}): RuntimeEventEnvelope {
		const streamKey = getStreamKeyForEvent(input.event);
		const row = this.db
			.select({
				sequence: sql<number>`coalesce(max(${runtimeEventLog.sequence}), 0)`,
			})
			.from(runtimeEventLog)
			.where(eq(runtimeEventLog.streamKey, streamKey))
			.get();
		const sequence = (row?.sequence ?? 0) + 1;
		const createdAt = Date.now();
		const eventId = crypto.randomUUID();

		this.db
			.insert(runtimeEventLog)
			.values({
				id: eventId,
				streamKey,
				sequence,
				sessionId: input.event.sessionId,
				turnId: input.event.turnId,
				commandId: input.commandId,
				eventType: input.event.type,
				payload: input.event,
				createdAt,
			})
			.run();

		return {
			commandId: input.commandId,
			createdAt,
			event: input.event,
			eventId,
			offset: formatStoredOffset(sequence),
			streamKey,
		};
	}

	getCurrentOffset(streamKey: string): RuntimeStreamOffset {
		const row = this.db
			.select({
				sequence: sql<number>`coalesce(max(${runtimeEventLog.sequence}), 0)`,
			})
			.from(runtimeEventLog)
			.where(eq(runtimeEventLog.streamKey, streamKey))
			.get();
		const sequence = row?.sequence ?? 0;
		return sequence > 0 ? formatStoredOffset(sequence) : STREAM_START_OFFSET;
	}

	getEventsAfterOffset(input: {
		limit?: number;
		streamKey: string;
		offset: RuntimeStreamOffset;
	}): RuntimeEventEnvelope[] {
		const afterOffset =
			input.offset === STREAM_NOW_OFFSET
				? Number.parseInt(this.getCurrentOffset(input.streamKey), 10) || 0
				: parseStoredOffset(input.offset);
		const rows = this.db
			.select()
			.from(runtimeEventLog)
			.where(
				and(
					eq(runtimeEventLog.streamKey, input.streamKey),
					gte(runtimeEventLog.sequence, afterOffset + 1)
				)
			)
			.orderBy(runtimeEventLog.sequence)
			.limit(input.limit ?? 1000)
			.all();

		return rows.map((row) => this.toEventEnvelope(row));
	}

	private toEventEnvelope(row: RuntimeEventLogRow): RuntimeEventEnvelope {
		return {
			commandId: row.commandId ?? undefined,
			createdAt: row.createdAt,
			event: row.payload as RuntimeEvent,
			eventId: row.id,
			offset: formatStoredOffset(row.sequence),
			streamKey: row.streamKey,
		};
	}
}
