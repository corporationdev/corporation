import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EnvironmentDurableObject } from "../src/environment-do";
import type { SpaceDurableObject } from "../src/space-do/object";

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
		throw new Error(`Expected websocket upgrade, got ${response.status}`);
	}
	const runtimeSocket = response.webSocket;
	if (!runtimeSocket) {
		throw new Error("Expected runtime websocket");
	}
	runtimeSocket.accept();
	return runtimeSocket;
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

describe("SpaceDurableObject createSession seam", () => {
	it("routes to the environment DO, creates the runtime session, and subscribes the stream", async () => {
		const environmentId = "environment-1";
		const spaceName = "space-1";
		const sessionId = "session-1";

		const environmentStub = env.ENVIRONMENT_DO.get(
			env.ENVIRONMENT_DO.idFromName(environmentId)
		);
		const runtimeSocket = await connectRuntimeSocket(environmentStub);

		const spaceStub = env.SPACE_DO.get(
			env.SPACE_DO.idFromName(spaceName)
		) as DurableObjectStub<SpaceDurableObject>;

		const createSessionPromise = spaceStub.createSession({
			sessionId,
			environmentId,
			spaceName,
			title: "My Session",
			agent: "claude",
			cwd: "/workspace",
			model: "claude-sonnet",
			mode: "build",
			configOptions: {
				approval: "never",
			},
		});

		const commandMessage = await waitForSocketMessage(runtimeSocket);
		expect(commandMessage).toEqual({
			type: "create_session",
			requestId: expect.any(String),
			input: {
				sessionId,
				agent: "claude",
				cwd: "/workspace",
				model: "claude-sonnet",
				mode: "build",
				configOptions: {
					approval: "never",
				},
			},
		});

		runtimeSocket.send(
			JSON.stringify({
				type: "response",
				requestId: commandMessage.requestId,
				ok: true,
				result: {
					session: {
						sessionId,
						activeTurnId: null,
						agent: "claude",
						cwd: "/workspace",
						model: "claude-sonnet",
						mode: "build",
						configOptions: {
							approval: "never",
						},
					},
				},
			})
		);

		await expect(waitForSocketMessage(runtimeSocket)).resolves.toEqual({
			type: "subscribe_stream",
			stream: `session:${sessionId}`,
			offset: "-1",
		});

		await expect(createSessionPromise).resolves.toMatchObject({
			ok: true,
			value: {
				session: {
					id: sessionId,
					environmentId,
					streamKey: `session:${sessionId}`,
					title: "My Session",
					agent: "claude",
					cwd: "/workspace",
					model: "claude-sonnet",
					mode: "build",
					lastAppliedOffset: "-1",
					lastSyncError: null,
				},
			},
		});

		const persisted = await runInDurableObject(spaceStub, async (instance) => {
			const space = instance as unknown as SpaceDurableObject & {
				getDb(): Promise<Awaited<ReturnType<SpaceDurableObject["getDb"]>>>;
			};
			const db = await space.getDb();
			return await db.query.sessions.findFirst({
				where: (table, { eq }) => eq(table.id, sessionId),
			});
		});

		expect(persisted).toMatchObject({
			id: sessionId,
			environmentId,
			streamKey: `session:${sessionId}`,
			title: "My Session",
			agent: "claude",
			cwd: "/workspace",
			model: "claude-sonnet",
			mode: "build",
			lastAppliedOffset: "-1",
			lastSyncError: null,
		});
	});

	it("marks the session as errored when create_session fails", async () => {
		const environmentId = "environment-error";
		const spaceName = "space-error";
		const sessionId = "session-error";

		const environmentStub = env.ENVIRONMENT_DO.get(
			env.ENVIRONMENT_DO.idFromName(environmentId)
		);
		const runtimeSocket = await connectRuntimeSocket(environmentStub);

		const spaceStub = env.SPACE_DO.get(
			env.SPACE_DO.idFromName(spaceName)
		) as DurableObjectStub<SpaceDurableObject>;

		const createSessionResult = spaceStub.createSession({
			sessionId,
			environmentId,
			spaceName,
			agent: "claude",
			cwd: "/workspace",
		});

		const commandMessage = await waitForSocketMessage(runtimeSocket);
		expect(commandMessage).toMatchObject({
			type: "create_session",
			input: {
				sessionId,
				agent: "claude",
				cwd: "/workspace",
			},
		});

		runtimeSocket.send(
			JSON.stringify({
				type: "response",
				requestId: commandMessage.requestId,
				ok: false,
				error: "create failed",
			})
		);

		await expect(createSessionResult).resolves.toMatchObject({
			ok: false,
			error: {
				message: "create failed",
			},
		});

		const persisted = await runInDurableObject(spaceStub, async (instance) => {
			const space = instance as unknown as SpaceDurableObject & {
				getDb(): Promise<Awaited<ReturnType<SpaceDurableObject["getDb"]>>>;
			};
			const db = await space.getDb();
			return await db.query.sessions.findFirst({
				where: (table, { eq }) => eq(table.id, sessionId),
			});
		});

		expect(persisted).toMatchObject({
			id: sessionId,
			environmentId,
			streamKey: `session:${sessionId}`,
			lastAppliedOffset: "-1",
			lastSyncError: "create failed",
		});
	});
});
