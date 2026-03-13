import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EnvironmentDurableObject } from "../src/environment-do";
import type { TestStreamConsumerDurableObject } from "../src/test-stream-consumer-do";

const RUNTIME_AUTH_HEADER = "x-space-runtime-auth";

function createRuntimeAuthHeader() {
	return JSON.stringify({
		authToken: "runtime-token",
		claims: {
			sub: "user-1",
			sandboxId: "sandbox-1",
			clientType: "sandbox_runtime",
			tokenType: "access",
			aud: "space-runtime-access",
			exp: Math.floor(Date.now() / 1000) + 60,
		},
	});
}

async function connectRuntimeSocket(
	stub: DurableObjectStub<EnvironmentDurableObject>
) {
	const response = await stub.fetch("http://fake/runtime/socket", {
		headers: {
			Upgrade: "websocket",
			[RUNTIME_AUTH_HEADER]: createRuntimeAuthHeader(),
		},
	});

	expect(response.status).toBe(101);
	const runtimeSocket = response.webSocket;
	expect(runtimeSocket).toBeTruthy();
	runtimeSocket?.accept();
	return runtimeSocket!;
}

async function waitForSocketMessage(
	socket: WebSocket
): Promise<Record<string, unknown>> {
	return await new Promise((resolve) => {
		socket.addEventListener(
			"message",
			(event) => {
				resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
			},
			{ once: true }
		);
	});
}

async function getReceivedStreamItems(
	stub: DurableObjectStub<TestStreamConsumerDurableObject>
) {
	const result = await stub.getReceivedStreamItems();
	expect(result.ok).toBe(true);
	if (!result.ok) {
		throw new Error("Expected received stream items snapshot");
	}
	return result.value.deliveries;
}

async function waitForReceivedStreamItems(input: {
	expectedCount: number;
	stub: DurableObjectStub<TestStreamConsumerDurableObject>;
}) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 2_000) {
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

		await expect(waitForSocketMessage(runtimeSocket)).resolves.toEqual({
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

		runtimeSocket.send(
			JSON.stringify({
				type: "stream_items",
				stream: "session:session-1",
				items: [
					{
						offset: "1",
						eventId: "event-1",
						createdAt: 123,
						event: {
							type: "turn.started",
							sessionId: "session-1",
							turnId: "turn-1",
						},
					},
				],
				nextOffset: "1",
				upToDate: true,
				streamClosed: false,
			})
		);

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
							type: "turn.started",
							sessionId: "session-1",
							turnId: "turn-1",
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

		runtimeSocket.send(
			JSON.stringify({
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
			})
		);

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

		runtimeSocket.send(
			JSON.stringify({
				type: "stream_items",
				stream: "session:session-1",
				items: [
					{ offset: "1", eventId: "a-1", createdAt: 1, event: { type: "a" } },
				],
				nextOffset: "1",
				upToDate: true,
				streamClosed: false,
			})
		);
		runtimeSocket.send(
			JSON.stringify({
				type: "stream_items",
				stream: "session:session-2",
				items: [
					{ offset: "1", eventId: "b-1", createdAt: 2, event: { type: "b" } },
				],
				nextOffset: "1",
				upToDate: true,
				streamClosed: false,
			})
		);

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
