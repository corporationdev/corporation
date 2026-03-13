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
});
