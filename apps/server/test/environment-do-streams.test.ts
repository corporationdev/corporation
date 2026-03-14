import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EnvironmentDurableObject } from "../src/environment-do";
import type { TestStreamConsumerDurableObject } from "../src/test-stream-consumer-do";

const RUNTIME_AUTH_HEADER = "x-space-runtime-auth";

type RuntimeSocketHarness = {
	socket: WebSocket;
	send: (payload: Record<string, unknown>) => void;
	waitForMessage: () => Promise<Record<string, unknown>>;
};

function createRuntimeAuthHeader() {
	return JSON.stringify({
		authToken: "runtime-token",
		claims: {
			sub: "user-1",
			clientId: "sandbox-1",
			clientType: "sandbox_runtime",
			tokenType: "access",
			aud: "space-runtime-access",
			exp: Math.floor(Date.now() / 1000) + 60,
		},
	});
}

async function connectRuntimeSocket(
	stub: DurableObjectStub<EnvironmentDurableObject>
): Promise<RuntimeSocketHarness> {
	const response = await stub.fetch("http://fake/runtime/socket", {
		headers: {
			Upgrade: "websocket",
			[RUNTIME_AUTH_HEADER]: createRuntimeAuthHeader(),
		},
	});

	if (response.status !== 101) {
		throw new Error(`Expected websocket upgrade, received ${response.status}`);
	}
	const runtimeSocket = response.webSocket;
	if (!runtimeSocket) {
		throw new Error("Expected runtime websocket");
	}
	runtimeSocket.accept();
	const queue: Record<string, unknown>[] = [];
	const waiters: Array<(message: Record<string, unknown>) => void> = [];

	runtimeSocket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as Record<string, unknown>;
		const waiter = waiters.shift();
		if (waiter) {
			waiter(message);
			return;
		}
		queue.push(message);
	});

	return {
		socket: runtimeSocket,
		send(payload) {
			runtimeSocket.send(JSON.stringify(payload));
		},
		waitForMessage() {
			const message = queue.shift();
			if (message) {
				return Promise.resolve(message);
			}
			return new Promise((resolve) => {
				waiters.push(resolve);
			});
		},
	};
}

async function getReceivedStreamItems(
	stub: DurableObjectStub<TestStreamConsumerDurableObject>
) {
	const result = await stub.getReceivedStreamItems();
	if (!result.ok) {
		throw new Error("Expected received stream items snapshot");
	}
	return result.value.deliveries;
}

async function setConsumerAckEnabled(input: {
	stub: DurableObjectStub<TestStreamConsumerDurableObject>;
	enabled: boolean;
}) {
	const result = await input.stub.setAckEnabled({ enabled: input.enabled });
	if (!result.ok) {
		throw new Error("Expected ack toggle to succeed");
	}
}

async function waitForReceivedStreamItems(input: {
	expectedCount: number;
	stub: DurableObjectStub<TestStreamConsumerDurableObject>;
}) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 2000) {
		const deliveries = await getReceivedStreamItems(input.stub);
		if (deliveries.length === input.expectedCount) {
			return deliveries;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for received stream items");
}

describe("EnvironmentDurableObject stream subscriptions", () => {
	it("registers a stream subscriber", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-register-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		await connectRuntimeSocket(stub);

		await expect(
			stub.subscribeStream({
				stream: "session:session-1",
				offset: "-1",
				subscriber: {
					callback: {
						binding: "TEST_STREAM_CONSUMER_DO",
						name: "consumer-1",
					},
					requesterId: "requester-1",
				},
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});

		await expect(stub.getStreamSubscriptionsSnapshot()).resolves.toEqual({
			ok: true,
			value: {
				subscriptions: [
					{
						stream: "session:session-1",
						requesterId: "requester-1",
						callbackBinding: "TEST_STREAM_CONSUMER_DO",
						callbackName: "consumer-1",
					},
				],
			},
		});
	});

	it("forwards subscribe_stream to the runtime", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-forward-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);

		const subscribePromise = stub.subscribeStream({
			stream: "session:session-1",
			offset: "5",
			subscriber: {
				callback: {
					binding: "TEST_STREAM_CONSUMER_DO",
					name: "consumer-1",
				},
				requesterId: "requester-1",
			},
		});

		await expect(runtimeSocket.waitForMessage()).resolves.toEqual({
			type: "subscribe_stream",
			stream: "session:session-1",
			offset: "5",
		});
		await expect(subscribePromise).resolves.toEqual({
			ok: true,
			value: {},
		});
	});

	it("fails to subscribe when no runtime is connected", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-disconnected-user");
		const stub = env.ENVIRONMENT_DO.get(id);

		await expect(
			stub.subscribeStream({
				stream: "session:session-1",
				offset: "-1",
				subscriber: {
					callback: {
						binding: "TEST_STREAM_CONSUMER_DO",
						name: "consumer-1",
					},
					requesterId: "requester-1",
				},
			})
		).resolves.toEqual({
			ok: false,
			error: {
				code: "runtime_not_connected",
				message: "Runtime is not connected",
			},
		});
		await expect(stub.getStreamSubscriptionsSnapshot()).resolves.toEqual({
			ok: true,
			value: {
				subscriptions: [],
			},
		});
	});

	it("removes a registered subscriber on unsubscribe", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-unsubscribe-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		await connectRuntimeSocket(stub);

		await expect(
			stub.subscribeStream({
				stream: "session:session-1",
				offset: "-1",
				subscriber: {
					callback: {
						binding: "TEST_STREAM_CONSUMER_DO",
						name: "consumer-1",
					},
					requesterId: "requester-1",
				},
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});

		await expect(
			stub.unsubscribeStream({
				stream: "session:session-1",
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});

		await expect(stub.getStreamSubscriptionsSnapshot()).resolves.toEqual({
			ok: true,
			value: {
				subscriptions: [],
			},
		});
	});

	it("is idempotent when unsubscribing an unknown stream", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-idempotent-user");
		const stub = env.ENVIRONMENT_DO.get(id);

		await expect(
			stub.unsubscribeStream({
				stream: "session:missing",
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});
		await expect(stub.getStreamSubscriptionsSnapshot()).resolves.toEqual({
			ok: true,
			value: {
				subscriptions: [],
			},
		});
	});

	it("replaces the subscriber when the same stream is resubscribed", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-replace-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		await connectRuntimeSocket(stub);

		await expect(
			stub.subscribeStream({
				stream: "session:session-1",
				offset: "-1",
				subscriber: {
					callback: {
						binding: "TEST_STREAM_CONSUMER_DO",
						name: "consumer-1",
					},
					requesterId: "requester-1",
				},
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});
		await expect(
			stub.subscribeStream({
				stream: "session:session-1",
				offset: "now",
				subscriber: {
					callback: {
						binding: "TEST_STREAM_CONSUMER_DO",
						name: "consumer-2",
					},
					requesterId: "requester-2",
				},
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});

		await expect(stub.getStreamSubscriptionsSnapshot()).resolves.toEqual({
			ok: true,
			value: {
				subscriptions: [
					{
						stream: "session:session-1",
						requesterId: "requester-2",
						callbackBinding: "TEST_STREAM_CONSUMER_DO",
						callbackName: "consumer-2",
					},
				],
			},
		});
	});

	it("re-subscribes persisted streams after runtime reconnect and routes replayed events from the stored offset", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-persisted-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);
		const consumerStub = env.TEST_STREAM_CONSUMER_DO.get(
			env.TEST_STREAM_CONSUMER_DO.idFromName("consumer-persisted")
		);
		const initialSubscribeMessagePromise = runtimeSocket.waitForMessage();

		await expect(
			stub.subscribeStream({
				stream: "session:session-1",
				offset: "5",
				subscriber: {
					callback: {
						binding: "TEST_STREAM_CONSUMER_DO",
						name: "consumer-persisted",
					},
					requesterId: "requester-1",
				},
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});
		await expect(initialSubscribeMessagePromise).resolves.toEqual({
			type: "subscribe_stream",
			stream: "session:session-1",
			offset: "5",
		});

		const reconnectedRuntimeSocket = await connectRuntimeSocket(stub);
		await expect(reconnectedRuntimeSocket.waitForMessage()).resolves.toEqual({
			type: "subscribe_stream",
			stream: "session:session-1",
			offset: "5",
		});

		reconnectedRuntimeSocket.send({
			type: "stream_items",
			stream: "session:session-1",
			items: [
				{
					offset: "6",
					eventId: "event-6",
					createdAt: 123,
					event: {
						kind: "status",
						sessionId: "session-1",
						status: "running",
					},
				},
				{
					offset: "7",
					eventId: "event-7",
					createdAt: 124,
					event: {
						kind: "status",
						sessionId: "session-1",
						status: "idle",
					},
				},
			],
			nextOffset: "7",
			upToDate: true,
			streamClosed: false,
		});

		await expect(
			waitForReceivedStreamItems({
				stub: consumerStub,
				expectedCount: 1,
			})
		).resolves.toEqual([
			{
				stream: "session:session-1",
				requesterId: "requester-1",
				items: [
					{
						offset: "6",
						eventId: "event-6",
						createdAt: 123,
						event: {
							kind: "status",
							sessionId: "session-1",
							status: "running",
						},
					},
					{
						offset: "7",
						eventId: "event-7",
						createdAt: 124,
						event: {
							kind: "status",
							sessionId: "session-1",
							status: "idle",
						},
					},
				],
				nextOffset: "7",
				upToDate: true,
				streamClosed: false,
			},
		]);
	});

	it("advances the persisted offset after a downstream ack", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-ack-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);
		const consumerStub = env.TEST_STREAM_CONSUMER_DO.get(
			env.TEST_STREAM_CONSUMER_DO.idFromName("consumer-ack")
		);

		await expect(
			stub.subscribeStream({
				stream: "session:session-1",
				offset: "5",
				subscriber: {
					callback: {
						binding: "TEST_STREAM_CONSUMER_DO",
						name: "consumer-ack",
					},
					requesterId: "requester-1",
				},
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});
		await expect(runtimeSocket.waitForMessage()).resolves.toEqual({
			type: "subscribe_stream",
			stream: "session:session-1",
			offset: "5",
		});

		runtimeSocket.send({
			type: "stream_items",
			stream: "session:session-1",
			items: [
				{
					offset: "6",
					eventId: "event-6",
					createdAt: 123,
					event: { kind: "status", status: "running" },
				},
				{
					offset: "7",
					eventId: "event-7",
					createdAt: 124,
					event: { kind: "status", status: "idle" },
				},
			],
			nextOffset: "7",
			upToDate: true,
			streamClosed: false,
		});

		await waitForReceivedStreamItems({
			stub: consumerStub,
			expectedCount: 1,
		});

		const reconnectedRuntimeSocket = await connectRuntimeSocket(stub);
		await expect(reconnectedRuntimeSocket.waitForMessage()).resolves.toEqual({
			type: "subscribe_stream",
			stream: "session:session-1",
			offset: "7",
		});
	});

	it("replays unacked events from the previous persisted offset after reconnect", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-no-ack-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);
		const consumerStub = env.TEST_STREAM_CONSUMER_DO.get(
			env.TEST_STREAM_CONSUMER_DO.idFromName("consumer-no-ack")
		);

		await setConsumerAckEnabled({
			stub: consumerStub,
			enabled: false,
		});

		await expect(
			stub.subscribeStream({
				stream: "session:session-1",
				offset: "5",
				subscriber: {
					callback: {
						binding: "TEST_STREAM_CONSUMER_DO",
						name: "consumer-no-ack",
					},
					requesterId: "requester-1",
				},
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});
		await expect(runtimeSocket.waitForMessage()).resolves.toEqual({
			type: "subscribe_stream",
			stream: "session:session-1",
			offset: "5",
		});

		const replayBatch = {
			type: "stream_items",
			stream: "session:session-1",
			items: [
				{
					offset: "6",
					eventId: "event-6",
					createdAt: 123,
					event: { kind: "status", status: "running" },
				},
				{
					offset: "7",
					eventId: "event-7",
					createdAt: 124,
					event: { kind: "status", status: "idle" },
				},
			],
			nextOffset: "7",
			upToDate: true,
			streamClosed: false,
		};

		runtimeSocket.send(replayBatch);

		await waitForReceivedStreamItems({
			stub: consumerStub,
			expectedCount: 1,
		});

		await setConsumerAckEnabled({
			stub: consumerStub,
			enabled: true,
		});

		const reconnectedRuntimeSocket = await connectRuntimeSocket(stub);
		await expect(reconnectedRuntimeSocket.waitForMessage()).resolves.toEqual({
			type: "subscribe_stream",
			stream: "session:session-1",
			offset: "5",
		});

		reconnectedRuntimeSocket.send(replayBatch);

		await expect(
			waitForReceivedStreamItems({
				stub: consumerStub,
				expectedCount: 2,
			})
		).resolves.toEqual([
			{
				stream: "session:session-1",
				requesterId: "requester-1",
				items: [
					{
						offset: "6",
						eventId: "event-6",
						createdAt: 123,
						event: { kind: "status", status: "running" },
					},
					{
						offset: "7",
						eventId: "event-7",
						createdAt: 124,
						event: { kind: "status", status: "idle" },
					},
				],
				nextOffset: "7",
				upToDate: true,
				streamClosed: false,
			},
			{
				stream: "session:session-1",
				requesterId: "requester-1",
				items: [
					{
						offset: "6",
						eventId: "event-6",
						createdAt: 123,
						event: { kind: "status", status: "running" },
					},
					{
						offset: "7",
						eventId: "event-7",
						createdAt: 124,
						event: { kind: "status", status: "idle" },
					},
				],
				nextOffset: "7",
				upToDate: true,
				streamClosed: false,
			},
		]);
	});

	it("routes stream_items to the registered subscriber", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-delivery-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);
		const consumerStub = env.TEST_STREAM_CONSUMER_DO.get(
			env.TEST_STREAM_CONSUMER_DO.idFromName("consumer-delivery")
		);

		await expect(
			stub.subscribeStream({
				stream: "session:session-1",
				offset: "-1",
				subscriber: {
					callback: {
						binding: "TEST_STREAM_CONSUMER_DO",
						name: "consumer-delivery",
					},
					requesterId: "requester-1",
				},
			})
		).resolves.toEqual({
			ok: true,
			value: {},
		});

		runtimeSocket.send({
			type: "stream_items",
			stream: "session:session-1",
			items: [
				{
					offset: "1",
					eventId: "event-1",
					createdAt: 123,
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
		});

		await expect(
			waitForReceivedStreamItems({
				stub: consumerStub,
				expectedCount: 1,
			})
		).resolves.toEqual([
			{
				stream: "session:session-1",
				requesterId: "requester-1",
				items: [
					{
						offset: "1",
						eventId: "event-1",
						createdAt: 123,
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
		]);
	});

	it("does not route stream_items for an unsubscribed stream", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-miss-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);
		const consumerStub = env.TEST_STREAM_CONSUMER_DO.get(
			env.TEST_STREAM_CONSUMER_DO.idFromName("consumer-miss")
		);

		runtimeSocket.send({
			type: "stream_items",
			stream: "session:missing",
			items: [
				{
					offset: "1",
					eventId: "event-1",
					createdAt: 123,
					event: { type: "noop" },
				},
			],
			nextOffset: "1",
			upToDate: true,
			streamClosed: false,
		});

		await expect(getReceivedStreamItems(consumerStub)).resolves.toEqual([]);
	});

	it("routes different streams to different subscribers", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("stream-multi-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);
		const firstConsumer = env.TEST_STREAM_CONSUMER_DO.get(
			env.TEST_STREAM_CONSUMER_DO.idFromName("consumer-a")
		);
		const secondConsumer = env.TEST_STREAM_CONSUMER_DO.get(
			env.TEST_STREAM_CONSUMER_DO.idFromName("consumer-b")
		);

		await stub.subscribeStream({
			stream: "session:session-1",
			offset: "-1",
			subscriber: {
				callback: {
					binding: "TEST_STREAM_CONSUMER_DO",
					name: "consumer-a",
				},
				requesterId: "requester-a",
			},
		});
		await stub.subscribeStream({
			stream: "session:session-2",
			offset: "-1",
			subscriber: {
				callback: {
					binding: "TEST_STREAM_CONSUMER_DO",
					name: "consumer-b",
				},
				requesterId: "requester-b",
			},
		});

		runtimeSocket.send({
			type: "stream_items",
			stream: "session:session-1",
			items: [
				{ offset: "1", eventId: "a-1", createdAt: 1, event: { type: "a" } },
			],
			nextOffset: "1",
			upToDate: true,
			streamClosed: false,
		});
		runtimeSocket.send({
			type: "stream_items",
			stream: "session:session-2",
			items: [
				{ offset: "1", eventId: "b-1", createdAt: 2, event: { type: "b" } },
			],
			nextOffset: "1",
			upToDate: true,
			streamClosed: false,
		});

		await expect(
			waitForReceivedStreamItems({ stub: firstConsumer, expectedCount: 1 })
		).resolves.toEqual([
			{
				stream: "session:session-1",
				requesterId: "requester-a",
				items: [
					{ offset: "1", eventId: "a-1", createdAt: 1, event: { type: "a" } },
				],
				nextOffset: "1",
				upToDate: true,
				streamClosed: false,
			},
		]);
		await expect(
			waitForReceivedStreamItems({ stub: secondConsumer, expectedCount: 1 })
		).resolves.toEqual([
			{
				stream: "session:session-2",
				requesterId: "requester-b",
				items: [
					{ offset: "1", eventId: "b-1", createdAt: 2, event: { type: "b" } },
				],
				nextOffset: "1",
				upToDate: true,
				streamClosed: false,
			},
		]);
	});
});
