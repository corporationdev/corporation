import type { SessionEvent } from "sandbox-agent";

type TurnRunnerError = {
	name: string;
	message: string;
	stack?: string | null;
};

type TurnRunnerCallbackBase = {
	turnId: string;
	sessionId: string;
	token: string;
	sequence: number;
	timestamp: number;
	lastEventIndex?: number;
};

export type TurnRunnerCallbackPayload =
	| (TurnRunnerCallbackBase & {
			kind: "started";
			agent: string;
			modelId: string | null;
	  })
	| (TurnRunnerCallbackBase & {
			kind: "events";
			events: SessionEvent[];
	  })
	| (TurnRunnerCallbackBase & {
			kind: "heartbeat";
	  })
	| (TurnRunnerCallbackBase & {
			kind: "completed";
			stopReason: string | null;
	  })
	| (TurnRunnerCallbackBase & {
			kind: "failed";
			error: TurnRunnerError;
	  });

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isSessionEvent(value: unknown): value is SessionEvent {
	if (!isRecord(value)) {
		return false;
	}

	return (
		isString(value.id) &&
		isNumber(value.eventIndex) &&
		isString(value.sessionId) &&
		isNumber(value.createdAt) &&
		isString(value.connectionId) &&
		isString(value.sender) &&
		isRecord(value.payload)
	);
}

function assertStringField(record: AnyRecord, key: string): string {
	const value = record[key];
	if (!isString(value) || value.length === 0) {
		throw new Error(`Turn runner callback payload missing ${key}`);
	}
	return value;
}

function assertBasePayload(value: unknown): TurnRunnerCallbackBase & AnyRecord {
	if (!isRecord(value)) {
		throw new Error("Turn runner callback payload must be an object");
	}

	const turnId = assertStringField(value, "turnId");
	const sessionId = assertStringField(value, "sessionId");
	const token = assertStringField(value, "token");

	if (!isNumber(value.sequence) || value.sequence < 1) {
		throw new Error("Turn runner callback payload has invalid sequence");
	}
	if (!isNumber(value.timestamp)) {
		throw new Error("Turn runner callback payload has invalid timestamp");
	}
	if (
		value.lastEventIndex !== undefined &&
		(!isNumber(value.lastEventIndex) || value.lastEventIndex < 0)
	) {
		throw new Error("Turn runner callback payload has invalid lastEventIndex");
	}

	return {
		...value,
		turnId,
		sessionId,
		token,
		sequence: value.sequence,
		timestamp: value.timestamp,
		lastEventIndex: isNumber(value.lastEventIndex)
			? value.lastEventIndex
			: undefined,
	};
}

function parseStartedPayload(
	base: TurnRunnerCallbackBase,
	record: AnyRecord
): TurnRunnerCallbackPayload {
	if (!isString(record.agent)) {
		throw new Error("Turn runner started payload is invalid");
	}
	if (record.modelId !== null && !isString(record.modelId)) {
		throw new Error("Turn runner started payload has invalid modelId");
	}
	return {
		...base,
		kind: "started",
		agent: record.agent,
		modelId: record.modelId,
	};
}

function parseEventsPayload(
	base: TurnRunnerCallbackBase,
	record: AnyRecord
): TurnRunnerCallbackPayload {
	if (!(Array.isArray(record.events) && record.events.every(isSessionEvent))) {
		throw new Error("Turn runner events payload is invalid");
	}
	return {
		...base,
		kind: "events",
		events: record.events,
	};
}

function parseCompletedPayload(
	base: TurnRunnerCallbackBase,
	record: AnyRecord
): TurnRunnerCallbackPayload {
	if (record.stopReason !== null && !isString(record.stopReason)) {
		throw new Error("Turn runner completed payload is invalid");
	}
	return {
		...base,
		kind: "completed",
		stopReason: record.stopReason,
	};
}

function parseFailedPayload(
	base: TurnRunnerCallbackBase,
	record: AnyRecord
): TurnRunnerCallbackPayload {
	if (!isRecord(record.error)) {
		throw new Error("Turn runner failed payload is invalid");
	}
	if (!(isString(record.error.name) && isString(record.error.message))) {
		throw new Error("Turn runner failed payload error is invalid");
	}
	if (
		record.error.stack !== undefined &&
		record.error.stack !== null &&
		!isString(record.error.stack)
	) {
		throw new Error("Turn runner failed payload stack is invalid");
	}

	return {
		...base,
		kind: "failed",
		error: {
			name: record.error.name,
			message: record.error.message,
			stack: record.error.stack ?? null,
		},
	};
}

export function parseTurnRunnerCallbackPayload(
	value: unknown
): TurnRunnerCallbackPayload {
	const record = assertBasePayload(value);
	const base: TurnRunnerCallbackBase = {
		turnId: record.turnId,
		sessionId: record.sessionId,
		token: record.token,
		sequence: record.sequence,
		timestamp: record.timestamp,
		lastEventIndex: record.lastEventIndex,
	};

	switch (record.kind) {
		case "started":
			return parseStartedPayload(base, record);
		case "events":
			return parseEventsPayload(base, record);
		case "heartbeat":
			return {
				...base,
				kind: "heartbeat",
			};
		case "completed":
			return parseCompletedPayload(base, record);
		case "failed":
			return parseFailedPayload(base, record);
		default:
			throw new Error("Turn runner callback payload has invalid kind");
	}
}
