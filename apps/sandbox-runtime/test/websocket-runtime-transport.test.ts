import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentRuntimeOutgoingMessage as RuntimeWebSocketOutgoingMessage } from "@corporation/contracts/environment-runtime";
import { openRuntimeDatabase } from "../db";
import { noopDriver, RuntimeEngine } from "../index";
import { RuntimeMessageStore } from "../runtime-message-store";
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

async function createTestDatabasePath(): Promise<{
	cleanup(): Promise<void>;
	dbPath: string;
}> {
	const tempDir = await mkdtemp(join(tmpdir(), "runtime-transport-db-"));
	return {
		dbPath: join(tempDir, "runtime.sqlite"),
		async cleanup() {
			await rm(tempDir, { recursive: true, force: true });
		},
	};
}

async function createTransportHarness(dbPath: string): Promise<{
	handle: Awaited<ReturnType<typeof openRuntimeDatabase>>;
	runtime: RuntimeEngine;
	socket: FakeSocket;
	start(): Promise<void>;
	transport: ReturnType<typeof createWebSocketRuntimeTransport>;
}> {
	const handle = await openRuntimeDatabase({ path: dbPath });
	const runtime = new RuntimeEngine(noopDriver);
	const socket = new FakeSocket();
	const transport = createWebSocketRuntimeTransport({
		store: new RuntimeMessageStore(handle.db),
		url: "ws://runtime.test/socket",
		runtime,
		createSocket() {
			return socket;
		},
	});

	return {
		handle,
		runtime,
		socket,
		async start() {
			const startPromise = transport.start();
			socket.receive({
				type: "hello_ack",
				connectionId: "connection-1",
				connectedAt: 123,
			});
			await startPromise;
		},
		transport,
	};
}

async function createReconnectHarness(dbPath: string): Promise<{
	handle: Awaited<ReturnType<typeof openRuntimeDatabase>>;
	runtime: RuntimeEngine;
	sockets: FakeSocket[];
	transport: ReturnType<typeof createWebSocketRuntimeTransport>;
}> {
	const handle = await openRuntimeDatabase({ path: dbPath });
	const runtime = new RuntimeEngine(noopDriver);
	const sockets: FakeSocket[] = [];
	const transport = createWebSocketRuntimeTransport({
		store: new RuntimeMessageStore(handle.db),
		url: "ws://runtime.test/socket",
		runtime,
		reconnectDelayMs: 0,
		createSocket() {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
	});

	return {
		handle,
		runtime,
		sockets,
		transport,
	};
}

async function dispatchCreateSessionAndPrompt(
	socket: FakeSocket
): Promise<void> {
	socket.receive({
		type: "create_session",
		requestId: "req-1",
		input: {
			sessionId: "session-1",
			agent: "claude",
			cwd: "/workspace/repo",
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
}

describe("createWebSocketRuntimeTransport", () => {
	test("handles commands and forwards runtime events over the socket", async () => {
		const testDb = await createTestDatabasePath();
		const harness = await createTransportHarness(testDb.dbPath);

		try {
			const startPromise = harness.transport.start();
			expect(harness.socket.sent).toEqual([
				{
					type: "hello",
					runtime: "sandbox-runtime",
				},
			]);
			harness.socket.receive({
				type: "hello_ack",
				connectionId: "connection-1",
				connectedAt: 123,
			});
			await startPromise;

			harness.socket.receive({
				type: "create_session",
				requestId: "req-1",
				input: {
					sessionId: "session-1",
					agent: "claude",
					cwd: "/workspace/repo",
					model: "sonnet",
				},
			});

			harness.socket.receive({
				type: "prompt",
				requestId: "req-2",
				input: {
					sessionId: "session-1",
					prompt: [{ type: "text", text: "hello" }],
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(harness.socket.sent).toEqual([
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
					type: "stream_items",
					stream: "session:session-1",
					items: [
						{
							offset: "1",
							eventId: expect.any(String),
							commandId: "req-2",
							createdAt: expect.any(Number),
							event: {
								kind: "status",
								sessionId: "session-1",
								status: "running",
							},
						},
					],
					nextOffset: "1",
					upToDate: true,
					streamClosed: false,
				},
				{
					type: "stream_items",
					stream: "session:session-1",
					items: [
						{
							offset: "2",
							eventId: expect.any(String),
							commandId: "req-2",
							createdAt: expect.any(Number),
							event: {
								kind: "text_delta",
								sessionId: "session-1",
								channel: "assistant",
								content: {
									type: "text",
									text: "noop driver ran",
								},
							},
						},
					],
					nextOffset: "2",
					upToDate: true,
					streamClosed: false,
				},
				{
					type: "stream_items",
					stream: "session:session-1",
					items: [
						{
							offset: "3",
							eventId: expect.any(String),
							commandId: "req-2",
							createdAt: expect.any(Number),
							event: {
								kind: "status",
								sessionId: "session-1",
								status: "idle",
								stopReason: "end_turn",
							},
						},
					],
					nextOffset: "3",
					upToDate: true,
					streamClosed: false,
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
		} finally {
			harness.handle.close();
			await testDb.cleanup();
		}
	});

	test("returns error responses for rejected commands", async () => {
		const testDb = await createTestDatabasePath();
		const harness = await createTransportHarness(testDb.dbPath);

		try {
			const startPromise = harness.transport.start();
			expect(harness.socket.sent).toEqual([
				{
					type: "hello",
					runtime: "sandbox-runtime",
				},
			]);
			harness.socket.receive({
				type: "hello_ack",
				connectionId: "connection-1",
				connectedAt: 123,
			});
			await startPromise;

			harness.socket.receive({
				type: "prompt",
				requestId: "req-1",
				input: {
					sessionId: "missing",
					prompt: [{ type: "text", text: "hello" }],
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(harness.socket.sent).toEqual([
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
		} finally {
			harness.handle.close();
			await testDb.cleanup();
		}
	});

	test("waits for hello acknowledgement before considering the transport started", async () => {
		const testDb = await createTestDatabasePath();
		const harness = await createTransportHarness(testDb.dbPath);

		try {
			let started = false;
			const startPromise = harness.transport.start().then(() => {
				started = true;
			});

			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(harness.socket.sent).toEqual([
				{
					type: "hello",
					runtime: "sandbox-runtime",
				},
			]);
			expect(started).toBe(false);

			harness.socket.receive({
				type: "hello_ack",
				connectionId: "connection-1",
				connectedAt: 123,
			});
			await startPromise;
			expect(started).toBe(true);
		} finally {
			harness.handle.close();
			await testDb.cleanup();
		}
	});

	test("reconnects automatically after websocket close and preserves events emitted while disconnected", async () => {
		const testDb = await createTestDatabasePath();
		const harness = await createReconnectHarness(testDb.dbPath);

		try {
			const startPromise = harness.transport.start();
			expect(harness.sockets).toHaveLength(1);
			expect(harness.sockets[0]?.sent).toEqual([
				{
					type: "hello",
					runtime: "sandbox-runtime",
				},
			]);
			harness.sockets[0]?.receive({
				type: "hello_ack",
				connectionId: "connection-1",
				connectedAt: 123,
			});
			await startPromise;

			await harness.runtime.createSession({
				sessionId: "session-1",
				agent: "claude",
				cwd: "/workspace/repo",
			});

			harness.sockets[0]?.close();
			await harness.runtime.prompt({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "hello after disconnect" }],
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(harness.sockets).toHaveLength(2);
			expect(harness.sockets[1]?.sent).toEqual([
				{
					type: "hello",
					runtime: "sandbox-runtime",
				},
			]);

			harness.sockets[1]?.receive({
				type: "hello_ack",
				connectionId: "connection-2",
				connectedAt: 124,
			});
			harness.sockets[1]?.receive({
				type: "subscribe_stream",
				stream: "session:session-1",
				offset: "-1",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(harness.sockets[1]?.sent).toEqual([
				{
					type: "hello",
					runtime: "sandbox-runtime",
				},
				{
					type: "stream_items",
					stream: "session:session-1",
					items: [
						{
							offset: "1",
							eventId: expect.any(String),
							commandId: undefined,
							createdAt: expect.any(Number),
							event: expect.objectContaining({
								kind: "status",
								sessionId: "session-1",
							}),
						},
						{
							offset: "2",
							eventId: expect.any(String),
							commandId: undefined,
							createdAt: expect.any(Number),
							event: expect.objectContaining({
								kind: "text_delta",
								sessionId: "session-1",
							}),
						},
						{
							offset: "3",
							eventId: expect.any(String),
							commandId: undefined,
							createdAt: expect.any(Number),
							event: expect.objectContaining({
								kind: "status",
								sessionId: "session-1",
							}),
						},
					],
					nextOffset: "3",
					upToDate: true,
					streamClosed: false,
				},
			]);
		} finally {
			harness.handle.close();
			await testDb.cleanup();
		}
	});

	test("replays stored events and dedupes duplicate commands", async () => {
		const testDb = await createTestDatabasePath();
		const harness = await createTransportHarness(testDb.dbPath);

		try {
			await harness.start();
			await dispatchCreateSessionAndPrompt(harness.socket);

			const sentAfterPrompt = harness.socket.sent.slice();
			harness.socket.receive({
				type: "subscribe_stream",
				stream: "session:session-1",
				offset: "1",
			});
			harness.socket.receive({
				type: "create_session",
				requestId: "req-1",
				input: {
					sessionId: "session-1",
					agent: "claude",
					cwd: "/workspace/repo",
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(harness.socket.sent.slice(sentAfterPrompt.length)).toEqual([
				{
					type: "stream_items",
					stream: "session:session-1",
					items: [
						{
							offset: "2",
							eventId: expect.any(String),
							commandId: "req-2",
							createdAt: expect.any(Number),
							event: expect.objectContaining({
								kind: "text_delta",
								sessionId: "session-1",
							}),
						},
						{
							offset: "3",
							eventId: expect.any(String),
							commandId: "req-2",
							createdAt: expect.any(Number),
							event: expect.objectContaining({
								kind: "status",
								sessionId: "session-1",
							}),
						},
					],
					nextOffset: "3",
					upToDate: true,
					streamClosed: false,
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
							configOptions: {},
						},
					},
				},
			]);
		} finally {
			harness.handle.close();
			await testDb.cleanup();
		}
	});

	test("dedupes completed commands across transport restart", async () => {
		const testDb = await createTestDatabasePath();
		const firstHarness = await createTransportHarness(testDb.dbPath);

		try {
			await firstHarness.start();
			await dispatchCreateSessionAndPrompt(firstHarness.socket);

			firstHarness.socket.close();
			firstHarness.handle.close();

			const secondHarness = await createTransportHarness(testDb.dbPath);
			try {
				await secondHarness.start();
				secondHarness.socket.receive({
					type: "prompt",
					requestId: "req-2",
					input: {
						sessionId: "session-1",
						prompt: [{ type: "text", text: "hello" }],
					},
				});
				await new Promise((resolve) => setTimeout(resolve, 0));

				expect(secondHarness.socket.sent).toEqual([
					{
						type: "hello",
						runtime: "sandbox-runtime",
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
			} finally {
				secondHarness.handle.close();
			}
		} finally {
			await testDb.cleanup();
		}
	});

	test("replays all unacked events after websocket crash and transport restart", async () => {
		const testDb = await createTestDatabasePath();
		const firstHarness = await createTransportHarness(testDb.dbPath);

		try {
			await firstHarness.start();
			await dispatchCreateSessionAndPrompt(firstHarness.socket);

			firstHarness.socket.close();
			firstHarness.handle.close();

			const secondHarness = await createTransportHarness(testDb.dbPath);
			try {
				await secondHarness.start();
				secondHarness.socket.receive({
					type: "subscribe_stream",
					stream: "session:session-1",
					offset: "-1",
				});
				await new Promise((resolve) => setTimeout(resolve, 0));

				expect(secondHarness.socket.sent).toEqual([
					{
						type: "hello",
						runtime: "sandbox-runtime",
					},
					{
						type: "stream_items",
						stream: "session:session-1",
						items: [
							{
								offset: "1",
								eventId: expect.any(String),
								commandId: "req-2",
								createdAt: expect.any(Number),
								event: expect.objectContaining({
									kind: "status",
									sessionId: "session-1",
								}),
							},
							{
								offset: "2",
								eventId: expect.any(String),
								commandId: "req-2",
								createdAt: expect.any(Number),
								event: expect.objectContaining({
									kind: "text_delta",
									sessionId: "session-1",
								}),
							},
							{
								offset: "3",
								eventId: expect.any(String),
								commandId: "req-2",
								createdAt: expect.any(Number),
								event: expect.objectContaining({
									kind: "status",
									sessionId: "session-1",
								}),
							},
						],
						nextOffset: "3",
						upToDate: true,
						streamClosed: false,
					},
				]);
			} finally {
				secondHarness.handle.close();
			}
		} finally {
			await testDb.cleanup();
		}
	});

	test("replays only events after the requested sequence across restart", async () => {
		const testDb = await createTestDatabasePath();
		const firstHarness = await createTransportHarness(testDb.dbPath);

		try {
			await firstHarness.start();
			await dispatchCreateSessionAndPrompt(firstHarness.socket);

			firstHarness.socket.close();
			firstHarness.handle.close();

			const secondHarness = await createTransportHarness(testDb.dbPath);
			try {
				await secondHarness.start();
				secondHarness.socket.receive({
					type: "subscribe_stream",
					stream: "session:session-1",
					offset: "2",
				});
				await new Promise((resolve) => setTimeout(resolve, 0));

				expect(secondHarness.socket.sent).toEqual([
					{
						type: "hello",
						runtime: "sandbox-runtime",
					},
					{
						type: "stream_items",
						stream: "session:session-1",
						items: [
							{
								offset: "3",
								eventId: expect.any(String),
								commandId: "req-2",
								createdAt: expect.any(Number),
								event: expect.objectContaining({
									kind: "status",
									sessionId: "session-1",
								}),
							},
						],
						nextOffset: "3",
						upToDate: true,
						streamClosed: false,
					},
				]);
			} finally {
				secondHarness.handle.close();
			}
		} finally {
			await testDb.cleanup();
		}
	});

	test('supports the "now" offset sentinel for tailing only future events', async () => {
		const testDb = await createTestDatabasePath();
		const harness = await createTransportHarness(testDb.dbPath);

		try {
			await harness.start();
			await dispatchCreateSessionAndPrompt(harness.socket);

			const sentAfterHistory = harness.socket.sent.slice();
			harness.socket.receive({
				type: "subscribe_stream",
				stream: "session:session-1",
				offset: "now",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(harness.socket.sent.slice(sentAfterHistory.length)).toEqual([
				{
					type: "stream_items",
					stream: "session:session-1",
					items: [],
					nextOffset: "3",
					upToDate: true,
					streamClosed: false,
				},
			]);
		} finally {
			harness.handle.close();
			await testDb.cleanup();
		}
	});
});
