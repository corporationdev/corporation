import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
	RuntimeTransport,
	type RuntimeTransportMessage,
} from "../src/runtime-transport";
import { makeWebSocketTurnEventCallback } from "../src/websocket-turn-event-callback";

type SessionEventMessage = Extract<
	RuntimeTransportMessage,
	{ type: "session_event_batch" }
>["events"][number];

function makeSessionEvent(id: string): SessionEventMessage {
	return {
		id,
		connectionId: "connection-1",
		createdAt: Date.now(),
		eventIndex: 0,
		payload: {
			jsonrpc: "2.0",
			id,
			method: "session/prompt",
			params: {
				sessionId: "session-1",
				prompt: [{ type: "text", text: `message-${id}` }],
			},
		},
		sender: "client",
		sessionId: "session-1",
	} as SessionEventMessage;
}

function makeTransportLayer(messages: RuntimeTransportMessage[]) {
	return Layer.succeed(RuntimeTransport, {
		status: () =>
			Effect.succeed({ state: "connected" as const, connectedAt: Date.now() }),
		send: (message: RuntimeTransportMessage) =>
			Effect.sync(() => {
				messages.push(message);
			}),
	});
}

describe("makeWebSocketTurnEventCallback", () => {
	test("batches session events and flushes them before completion", async () => {
		const messages: RuntimeTransportMessage[] = [];
		const callback = await Effect.runPromise(
			makeWebSocketTurnEventCallback({
				turnId: "turn-1",
				sessionId: "session-1",
			}).pipe(Effect.provide(makeTransportLayer(messages)))
		);

		await Effect.runPromise(
			callback({
				_tag: "SessionEvent",
				event: makeSessionEvent("event-1"),
			}).pipe(Effect.provide(makeTransportLayer(messages)))
		);
		await Effect.runPromise(
			callback({
				_tag: "SessionEvent",
				event: makeSessionEvent("event-2"),
			}).pipe(Effect.provide(makeTransportLayer(messages)))
		);
		await Effect.runPromise(
			callback({
				_tag: "Completed",
			}).pipe(Effect.provide(makeTransportLayer(messages)))
		);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			type: "session_event_batch",
			turnId: "turn-1",
			sessionId: "session-1",
		});
		expect(
			(
				messages[0] as Extract<
					RuntimeTransportMessage,
					{ type: "session_event_batch" }
				>
			).events
		).toHaveLength(2);
		expect(
			(
				messages[0] as Extract<
					RuntimeTransportMessage,
					{ type: "session_event_batch" }
				>
			).events[0]
		).toMatchObject({
			id: "event-1",
			connectionId: "connection-1",
			sender: "client",
			sessionId: "session-1",
		});
		expect(
			(
				messages[0] as Extract<
					RuntimeTransportMessage,
					{ type: "session_event_batch" }
				>
			).events[1]
		).toMatchObject({
			id: "event-2",
			connectionId: "connection-1",
			sender: "client",
			sessionId: "session-1",
		});
		expect(messages[1]).toEqual({
			type: "turn_completed",
			turnId: "turn-1",
			sessionId: "session-1",
		});
	});

	test("sends terminal failure after flushing queued events", async () => {
		const messages: RuntimeTransportMessage[] = [];
		const callback = await Effect.runPromise(
			makeWebSocketTurnEventCallback({
				turnId: "turn-2",
				sessionId: "session-2",
			}).pipe(Effect.provide(makeTransportLayer(messages)))
		);
		const event = {
			_tag: "SessionEvent" as const,
			event: {
				...makeSessionEvent("event-3"),
				sessionId: "session-2",
			},
		};

		await Effect.runPromise(
			callback(event).pipe(Effect.provide(makeTransportLayer(messages)))
		);
		await Effect.runPromise(
			callback({
				_tag: "Failed",
				error: {
					name: "RuntimeActionError",
					message: "boom",
					stack: null,
				},
			}).pipe(Effect.provide(makeTransportLayer(messages)))
		);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			type: "session_event_batch",
			turnId: "turn-2",
			sessionId: "session-2",
		});
		expect(messages[1]).toEqual({
			type: "turn_failed",
			turnId: "turn-2",
			sessionId: "session-2",
			error: {
				name: "RuntimeActionError",
				message: "boom",
				stack: null,
			},
		});
	});
});
