import { env, runInDurableObject } from "cloudflare:test";
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

function captureRejection<T>(promise: Promise<T>): Promise<Error> {
	return promise.then(
		() => new Error("Expected promise to reject"),
		(error) => (error instanceof Error ? error : new Error(String(error)))
	);
}

async function connectRuntimeSocket(stub: DurableObjectStub<EnvironmentDurableObject>) {
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

describe("EnvironmentDurableObject", () => {
	it("returns 404 for unknown paths", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("test-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const response = await stub.fetch("http://fake/unknown");
		expect(response.status).toBe(404);
	});

	it("rejects runtime socket upgrade without auth", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("test-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const response = await stub.fetch("http://fake/runtime/socket", {
			headers: { Upgrade: "websocket" },
		});
		expect(response.status).toBe(401);
	});

	it("stores the active runtime websocket connection", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const response = await stub.fetch("http://fake/runtime/socket", {
			headers: {
				Upgrade: "websocket",
				[RUNTIME_AUTH_HEADER]: createRuntimeAuthHeader(),
			},
		});

		expect(response.status).toBe(101);

		const snapshot = await stub.getRuntimeConnectionsSnapshot();

		expect(snapshot.connected).toBe(true);
		expect(snapshot.connectionCount).toBe(1);
		expect(snapshot.activeConnectionId).toBeTruthy();
		expect(snapshot.activeConnection?.userId).toBe("user-1");
		expect(snapshot.activeConnection?.clientId).toBe("sandbox-1");
		expect(snapshot.connections).toEqual([snapshot.activeConnection]);
	});

	it("rebuilds runtime websocket state from durable object web socket attachments", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-rebuild-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const response = await stub.fetch("http://fake/runtime/socket", {
			headers: {
				Upgrade: "websocket",
				[RUNTIME_AUTH_HEADER]: createRuntimeAuthHeader(),
			},
		});

		expect(response.status).toBe(101);

		const snapshot = await runInDurableObject(stub, (instance) => {
			const environment = instance as unknown as EnvironmentDurableObject & {
				activeRuntimeConnectionId: string | null;
				runtimeConnections: Map<string, unknown>;
				rebuildConnectionsFromHibernation(): void;
			};
			environment.activeRuntimeConnectionId = null;
			environment.runtimeConnections.clear();
			environment.rebuildConnectionsFromHibernation();
			return environment.getRuntimeConnectionsSnapshot();
		});

		expect(snapshot).toMatchObject({
			connected: true,
			connectionCount: 1,
			activeConnection: {
				userId: "user-1",
				clientId: "sandbox-1",
			},
		});
	});

	it("forwards runtime commands and resolves the matching response", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-command-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);

		const commandPromise = stub.sendRuntimeCommand({
			type: "get_session",
			requestId: "req-1",
			input: {
				sessionId: "session-1",
			},
		});

		const outboundMessage = await waitForSocketMessage(runtimeSocket!);
		expect(outboundMessage).toEqual({
			type: "get_session",
			requestId: "req-1",
			input: {
				sessionId: "session-1",
			},
		});

		runtimeSocket?.send(
			JSON.stringify({
				type: "response",
				requestId: "req-1",
				ok: true,
				result: {
					session: null,
				},
			})
		);

		await expect(commandPromise).resolves.toEqual({
			type: "response",
			requestId: "req-1",
			ok: true,
			result: {
				session: null,
			},
		});
	});

	it("rejects runtime commands when no runtime is connected", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-disconnected-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const rejection = captureRejection(
			stub.sendRuntimeCommand({
				type: "get_session",
				requestId: "req-disconnected",
				input: {
					sessionId: "session-1",
				},
			})
		);

		await expect(rejection).resolves.toMatchObject({
			message: "Runtime is not connected",
		});
	});

	it("rejects an in-flight command if the runtime socket closes", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-close-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);

		const commandRejection = captureRejection(
			stub.sendRuntimeCommand({
				type: "get_session",
				requestId: "req-close",
				input: {
					sessionId: "session-1",
				},
			})
		);

		await expect(waitForSocketMessage(runtimeSocket)).resolves.toEqual({
			type: "get_session",
			requestId: "req-close",
			input: {
				sessionId: "session-1",
			},
		});

		runtimeSocket.close(1011, "runtime crashed");

		await expect(commandRejection).resolves.toMatchObject({
			message: "Runtime connection closed while request was in flight",
		});
	});

	it("matches concurrent responses by request id", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-concurrent-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);

		const firstPromise = stub.sendRuntimeCommand({
			type: "get_session",
			requestId: "req-1",
			input: {
				sessionId: "session-1",
			},
		});
		const secondPromise = stub.sendRuntimeCommand({
			type: "get_session",
			requestId: "req-2",
			input: {
				sessionId: "session-2",
			},
		});

		const firstOutbound = await waitForSocketMessage(runtimeSocket);
		const secondOutbound = await waitForSocketMessage(runtimeSocket);
		expect([firstOutbound, secondOutbound]).toEqual(
			expect.arrayContaining([
				{
					type: "get_session",
					requestId: "req-1",
					input: {
						sessionId: "session-1",
					},
				},
				{
					type: "get_session",
					requestId: "req-2",
					input: {
						sessionId: "session-2",
					},
				},
			])
		);

		runtimeSocket.send(
			JSON.stringify({
				type: "response",
				requestId: "req-2",
				ok: true,
				result: {
					session: {
						sessionId: "session-2",
						activeTurnId: null,
						agent: "claude",
						cwd: "/workspace/two",
						configOptions: {},
					},
				},
			})
		);
		runtimeSocket.send(
			JSON.stringify({
				type: "response",
				requestId: "req-1",
				ok: true,
				result: {
					session: null,
				},
			})
		);

		await expect(firstPromise).resolves.toEqual({
			type: "response",
			requestId: "req-1",
			ok: true,
			result: {
				session: null,
			},
		});
		await expect(secondPromise).resolves.toEqual({
			type: "response",
			requestId: "req-2",
			ok: true,
			result: {
				session: {
					sessionId: "session-2",
					activeTurnId: null,
					agent: "claude",
					cwd: "/workspace/two",
					configOptions: {},
				},
			},
		});
	});
});
