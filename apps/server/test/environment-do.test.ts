import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EnvironmentDurableObject } from "../src/environment-do";

const RUNTIME_AUTH_HEADER = "x-space-runtime-auth";

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

async function connectRuntimeSocket(
	stub: DurableObjectStub<EnvironmentDurableObject>
) {
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
	return runtimeSocket;
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

		const snapshotResult = await stub.getRuntimeConnectionsSnapshot();
		expect(snapshotResult.ok).toBe(true);
		if (!snapshotResult.ok) {
			throw new Error("Expected runtime connection snapshot");
		}
		const snapshot = snapshotResult.value.snapshot;

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

		const snapshotResult = await runInDurableObject(stub, (instance) => {
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
		expect(snapshotResult.ok).toBe(true);
		if (!snapshotResult.ok) {
			throw new Error("Expected runtime connection snapshot");
		}
		const snapshot = snapshotResult.value.snapshot;

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
			type: "abort",
			requestId: "req-1",
			input: {
				sessionId: "session-1",
			},
		});

		const outboundMessage = await waitForSocketMessage(runtimeSocket);
		expect(outboundMessage).toEqual({
			type: "abort",
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
					aborted: true,
				},
			})
		);

		await expect(commandPromise).resolves.toEqual({
			ok: true,
			value: {
				response: {
					type: "response",
					requestId: "req-1",
					ok: true,
					result: {
						aborted: true,
					},
				},
			},
		});
	});

	it("rejects runtime commands when no runtime is connected", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-disconnected-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		await expect(
			stub.sendRuntimeCommand({
				type: "abort",
				requestId: "req-disconnected",
				input: {
					sessionId: "session-1",
				},
			})
		).resolves.toEqual({
			ok: false,
			error: {
				code: "runtime_not_connected",
				message: "Runtime is not connected",
			},
		});
	});

	it("rejects an in-flight command if the runtime socket closes", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-close-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);

		const commandResult = stub.sendRuntimeCommand({
			type: "abort",
			requestId: "req-close",
			input: {
				sessionId: "session-1",
			},
		});

		await expect(waitForSocketMessage(runtimeSocket)).resolves.toEqual({
			type: "abort",
			requestId: "req-close",
			input: {
				sessionId: "session-1",
			},
		});

		runtimeSocket.close(1011, "runtime crashed");

		await expect(commandResult).resolves.toEqual({
			ok: false,
			error: {
				code: "runtime_connection_closed",
				message: "Runtime connection closed while request was in flight",
			},
		});
	});

	it("marks the environment as disconnected after the runtime socket closes", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-close-snapshot-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);

		runtimeSocket.close(1000, "done");

		const snapshotResult = await stub.getRuntimeConnectionsSnapshot();
		expect(snapshotResult.ok).toBe(true);
		if (!snapshotResult.ok) {
			throw new Error("Expected runtime connection snapshot");
		}

		expect(snapshotResult.value.snapshot).toEqual({
			activeConnection: null,
			activeConnectionId: null,
			connected: false,
			connectionCount: 0,
			connections: [],
		});

		await expect(stub.hasConnectedRuntime()).resolves.toEqual({
			ok: true,
			value: {
				connected: false,
			},
		});
	});

	it("matches concurrent responses by request id", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("runtime-concurrent-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const runtimeSocket = await connectRuntimeSocket(stub);

		const firstPromise = stub.sendRuntimeCommand({
			type: "abort",
			requestId: "req-1",
			input: {
				sessionId: "session-1",
			},
		});
		const secondPromise = stub.sendRuntimeCommand({
			type: "abort",
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
					type: "abort",
					requestId: "req-1",
					input: {
						sessionId: "session-1",
					},
				},
				{
					type: "abort",
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
					aborted: false,
				},
			})
		);
		runtimeSocket.send(
			JSON.stringify({
				type: "response",
				requestId: "req-1",
				ok: true,
				result: {
					aborted: true,
				},
			})
		);

		await expect(firstPromise).resolves.toEqual({
			ok: true,
			value: {
				response: {
					type: "response",
					requestId: "req-1",
					ok: true,
					result: {
						aborted: true,
					},
				},
			},
		});
		await expect(secondPromise).resolves.toEqual({
			ok: true,
			value: {
				response: {
					type: "response",
					requestId: "req-2",
					ok: true,
					result: {
						aborted: false,
					},
				},
			},
		});
	});
});
