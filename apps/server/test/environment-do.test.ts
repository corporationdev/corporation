import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

		const snapshot = await runInDurableObject(stub, (instance) =>
			instance.getRuntimeConnectionsSnapshot()
		);

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
			const environment = instance as unknown as {
				activeRuntimeConnectionId: string | null;
				runtimeConnections: Map<string, unknown>;
				rebuildConnectionsFromHibernation(): void;
				getRuntimeConnectionsSnapshot(): unknown;
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
});
