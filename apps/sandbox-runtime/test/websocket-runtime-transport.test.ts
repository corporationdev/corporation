import { describe, expect, test } from "bun:test";
import { noopDriver, RuntimeEngine } from "../index";
import type { RuntimeWebSocketOutgoingMessage } from "../runtime-websocket-protocol";
import {
	createWebSocketRuntimeTransport,
	type WebSocketLike,
} from "../websocket-runtime-transport";

class FakeSocket implements WebSocketLike {
	readyState = 1;
	readonly sent: RuntimeWebSocketOutgoingMessage[] = [];
	private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

	send(data: string): void {
		this.sent.push(JSON.parse(data) as RuntimeWebSocketOutgoingMessage);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", {});
	}

	addEventListener(
		type: "open" | "message" | "close" | "error",
		listener: ((event: { data: string }) => void) | ((event: Event) => void)
	): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener as (event: unknown) => void);
		this.listeners.set(type, listeners);
	}

	receive(message: unknown): void {
		this.emit("message", {
			data: JSON.stringify(message),
		});
	}

	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

describe("createWebSocketRuntimeTransport", () => {
	test("handles commands and forwards runtime events over the socket", async () => {
		const runtime = new RuntimeEngine(noopDriver);
		const socket = new FakeSocket();
		const transport = createWebSocketRuntimeTransport({
			url: "ws://runtime.test/socket",
			runtime,
			createSocket() {
				return socket;
			},
		});

		const startPromise = transport.start();
		expect(socket.sent).toEqual([
			{
				type: "hello",
				runtime: "sandbox-runtime",
			},
		]);
		socket.receive({
			type: "hello_ack",
			connectionId: "connection-1",
			connectedAt: 123,
		});
		await startPromise;

		socket.receive({
			type: "create_session",
			requestId: "req-1",
			input: {
				sessionId: "session-1",
				agent: "claude",
				cwd: "/workspace/repo",
				model: "sonnet",
			},
		});

		socket.receive({
			type: "prompt",
			requestId: "req-2",
			input: {
				sessionId: "session-1",
				prompt: [{ type: "text", text: "hello" }],
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(socket.sent).toEqual([
			{
				type: "hello",
				runtime: "sandbox-runtime",
			},
			{
				type: "response",
				requestId: "req-1",
				ok: true,
				result: {
					session: {
						sessionId: "session-1",
						activeTurnId: null,
						agent: "claude",
						cwd: "/workspace/repo",
						model: "sonnet",
						configOptions: {},
					},
				},
			},
			{
				type: "runtime_event",
				event: {
					type: "turn.started",
					sessionId: "session-1",
					turnId: expect.any(String),
				},
			},
			{
				type: "runtime_event",
				event: {
					type: "output.delta",
					sessionId: "session-1",
					turnId: expect.any(String),
					channel: "assistant",
					content: {
						type: "text",
						text: "noop driver ran",
					},
				},
			},
			{
				type: "runtime_event",
				event: {
					type: "turn.completed",
					sessionId: "session-1",
					turnId: expect.any(String),
					stopReason: "end_turn",
				},
			},
			{
				type: "response",
				requestId: "req-2",
				ok: true,
				result: {
					turnId: expect.any(String),
				},
			},
		]);
	});

	test("returns error responses for rejected commands", async () => {
		const runtime = new RuntimeEngine(noopDriver);
		const socket = new FakeSocket();
		const transport = createWebSocketRuntimeTransport({
			url: "ws://runtime.test/socket",
			runtime,
			createSocket() {
				return socket;
			},
		});

		const startPromise = transport.start();
		expect(socket.sent).toEqual([
			{
				type: "hello",
				runtime: "sandbox-runtime",
			},
		]);
		socket.receive({
			type: "hello_ack",
			connectionId: "connection-1",
			connectedAt: 123,
		});
		await startPromise;

		socket.receive({
			type: "prompt",
			requestId: "req-1",
			input: {
				sessionId: "missing",
				prompt: [{ type: "text", text: "hello" }],
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(socket.sent).toEqual([
			{
				type: "hello",
				runtime: "sandbox-runtime",
			},
			{
				type: "response",
				requestId: "req-1",
				ok: false,
				error: "Session missing does not exist",
			},
		]);
	});

	test("waits for hello acknowledgement before considering the transport started", async () => {
		const runtime = new RuntimeEngine(noopDriver);
		const socket = new FakeSocket();
		const transport = createWebSocketRuntimeTransport({
			url: "ws://runtime.test/socket",
			runtime,
			createSocket() {
				return socket;
			},
		});

		let started = false;
		const startPromise = transport.start().then(() => {
			started = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(socket.sent).toEqual([
			{
				type: "hello",
				runtime: "sandbox-runtime",
			},
		]);
		expect(started).toBe(false);

		socket.receive({
			type: "hello_ack",
			connectionId: "connection-1",
			connectedAt: 123,
		});
		await startPromise;
		expect(started).toBe(true);
	});
});
