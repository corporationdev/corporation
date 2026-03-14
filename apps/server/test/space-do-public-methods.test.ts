import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EnvironmentDurableObject } from "../src/environment-do";
import { sessions } from "../src/space-do/db/schema";
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

async function seedSession(input: {
	spaceName: string;
	sessionId: string;
	environmentId: string;
}) {
	const spaceStub = env.SPACE_DO.get(
		env.SPACE_DO.idFromName(input.spaceName)
	) as DurableObjectStub<SpaceDurableObject>;

	await runInDurableObject(spaceStub, async (instance) => {
		const space = instance as unknown as SpaceDurableObject & {
			getDb(): Promise<Awaited<ReturnType<SpaceDurableObject["getDb"]>>>;
		};
		const db = await space.getDb();
		const now = Date.now();
		await db.insert(sessions).values({
			id: input.sessionId,
			environmentId: input.environmentId,
			streamKey: `session:${input.sessionId}`,
			title: "Seeded Session",
			agent: "claude",
			cwd: "/workspace",
			model: "claude-sonnet",
			mode: "build",
			configOptions: { approval: "never" },
			lastAppliedOffset: "3",
			lastEventAt: 123,
			lastSyncError: null,
			createdAt: now,
			updatedAt: now,
			archivedAt: null,
		});
	});

	return spaceStub;
}

describe("SpaceDurableObject public methods", () => {
	it("getSession reads the persisted session from sqlite", async () => {
		const spaceStub = await seedSession({
			spaceName: "space-public-get",
			sessionId: "session-1",
			environmentId: "environment-1",
		});

		await expect(
			spaceStub.getSession({
				sessionId: "session-1",
			})
		).resolves.toMatchObject({
			id: "session-1",
			environmentId: "environment-1",
			streamKey: "session:session-1",
			title: "Seeded Session",
			lastAppliedOffset: "3",
		});
	});

	it("promptSession proxies a prompt command to the environment runtime", async () => {
		const environmentStub = env.ENVIRONMENT_DO.get(
			env.ENVIRONMENT_DO.idFromName("environment-prompt")
		);
		const runtimeSocket = await connectRuntimeSocket(environmentStub);
		const spaceStub = await seedSession({
			spaceName: "space-public-prompt",
			sessionId: "session-prompt",
			environmentId: "environment-prompt",
		});

		const promptPromise = spaceStub.promptSession({
			sessionId: "session-prompt",
			prompt: [{ type: "text", text: "hello" }],
			model: "gpt-5",
			mode: "build",
			configOptions: {
				approval: "never",
			},
		});

		const outboundMessage = await waitForSocketMessage(runtimeSocket);
		expect(outboundMessage).toEqual({
			type: "prompt",
			requestId: expect.any(String),
			input: {
				sessionId: "session-prompt",
				prompt: [{ type: "text", text: "hello" }],
				model: "gpt-5",
				mode: "build",
				configOptions: {
					approval: "never",
				},
			},
		});

		runtimeSocket.send(
			JSON.stringify({
				type: "response",
				requestId: outboundMessage.requestId,
				ok: true,
				result: {
					turnId: "turn-1",
				},
			})
		);

		await expect(promptPromise).resolves.toBeNull();
	});

	it("abortSession proxies the abort command and returns the runtime result", async () => {
		const environmentStub = env.ENVIRONMENT_DO.get(
			env.ENVIRONMENT_DO.idFromName("environment-abort")
		);
		const runtimeSocket = await connectRuntimeSocket(environmentStub);
		const spaceStub = await seedSession({
			spaceName: "space-public-abort",
			sessionId: "session-abort",
			environmentId: "environment-abort",
		});

		const abortPromise = spaceStub.abortSession({
			sessionId: "session-abort",
		});

		const outboundMessage = await waitForSocketMessage(runtimeSocket);
		expect(outboundMessage).toEqual({
			type: "abort",
			requestId: expect.any(String),
			input: {
				sessionId: "session-abort",
			},
		});

		runtimeSocket.send(
			JSON.stringify({
				type: "response",
				requestId: outboundMessage.requestId,
				ok: true,
				result: {
					aborted: true,
				},
			})
		);

		await expect(abortPromise).resolves.toBe(true);
	});

	it("respondToPermission proxies the runtime command and returns handled", async () => {
		const environmentStub = env.ENVIRONMENT_DO.get(
			env.ENVIRONMENT_DO.idFromName("environment-permission")
		);
		const runtimeSocket = await connectRuntimeSocket(environmentStub);
		const spaceStub = await seedSession({
			spaceName: "space-public-permission",
			sessionId: "session-permission",
			environmentId: "environment-permission",
		});

		const respondPromise = spaceStub.respondToPermission({
			sessionId: "session-permission",
			requestId: "permission-1",
			outcome: {
				outcome: "selected",
				optionId: "allow",
			},
		});

		const outboundMessage = await waitForSocketMessage(runtimeSocket);
		expect(outboundMessage).toEqual({
			type: "respond_to_permission",
			requestId: expect.any(String),
			input: {
				requestId: "permission-1",
				outcome: {
					outcome: "selected",
					optionId: "allow",
				},
			},
		});

		runtimeSocket.send(
			JSON.stringify({
				type: "response",
				requestId: outboundMessage.requestId,
				ok: true,
				result: {
					handled: true,
				},
			})
		);

		await expect(respondPromise).resolves.toBe(true);
	});
});
