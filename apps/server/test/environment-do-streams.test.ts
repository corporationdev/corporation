import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EnvironmentDurableObject } from "../src/environment-do";

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
					},
				],
			},
		});
	});
});
