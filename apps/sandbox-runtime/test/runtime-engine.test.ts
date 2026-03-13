import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "../runtime-events";
import { RuntimeEngine } from "../index";
import type {
	CreateSessionInput,
	ResolvedStartTurnInput,
} from "../runtime-types";

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

describe("RuntimeEngine", () => {
	test("session.create creates a session resource and emits session.created", async () => {
		const driverCreates: CreateSessionInput[] = [];
		const events: RuntimeEvent[] = [];
		const engine = new RuntimeEngine(
			{
				createSession: (input) => {
					driverCreates.push(input);
					return Promise.resolve();
				},
				run: () => Promise.resolve(undefined),
			},
			(event) => {
				events.push(event);
			}
		);

		const created = await engine.session.create({
			sessionId: "session-1",
			title: "Repo Session",
			agent: "claude",
			directory: "/workspace/repo",
			model: {
				providerID: "anthropic",
				modelID: "sonnet",
			},
			mode: "fast",
			configOptions: { effort: "high" },
		});

		expect(driverCreates).toEqual([
			{
				sessionId: "session-1",
				staticConfig: { agent: "claude", cwd: "/workspace/repo" },
				dynamicConfig: {
					modelId: "sonnet",
					modeId: "fast",
					configOptions: { effort: "high" },
				},
			},
		]);
		expect(created).toEqual({
			id: "session-1",
			title: "Repo Session",
			directory: "/workspace/repo",
			agent: "claude",
			model: {
				providerID: "anthropic",
				modelID: "sonnet",
			},
			mode: "fast",
			configOptions: { effort: "high" },
			activeTurnId: null,
			status: "idle",
			createdAt: expect.any(Number),
			updatedAt: expect.any(Number),
		});
		expect(engine.session.get("session-1")).toEqual(created);
		expect(events).toEqual([
			{
				type: "session.created",
				session: created,
			},
		]);
	});

	test("session.prompt emits runtime message and session events", async () => {
		const blocker = createDeferred();
		const driverCalls: ResolvedStartTurnInput[] = [];
		const events: RuntimeEvent[] = [];
		const engine = new RuntimeEngine(
			{
				run: async (input, emit) => {
					driverCalls.push(input);
					emit({
						type: "message.part.updated",
						part: {
							id: "assistant-part-1",
							sessionId: input.sessionId,
							messageId: input.assistantMessageId,
							type: "text",
							text: "READY",
						},
					});
					emit({
						type: "message.part.delta",
						sessionId: input.sessionId,
						messageId: input.assistantMessageId,
						partId: "assistant-part-1",
						field: "text",
						delta: "READY",
					});
					await blocker.promise;
					return { stopReason: "end_turn" };
				},
			},
			(event) => {
				events.push(event);
			}
		);

		await engine.session.create({
			sessionId: "session-1",
			agent: "claude",
			directory: "/workspace/repo",
			model: {
				providerID: "anthropic",
				modelID: "sonnet",
			},
		});

		const running = engine.session.prompt({
			sessionId: "session-1",
			parts: [{ type: "text", text: "hello" }],
		});

		await expect(
			engine.session.prompt({
				sessionId: "session-1",
				parts: [{ type: "text", text: "again" }],
			})
		).rejects.toThrow("Session session-1 already has active turn");

		blocker.resolve();
		const result = await running;

		expect(result.sessionId).toBe("session-1");
		expect(result.messageId).toEqual(expect.any(String));
		expect(result.stopReason).toBe("end_turn");
		expect(result.completedAt).toEqual(expect.any(Number));
		expect(result.parts).toEqual([
			{
				id: "assistant-part-1",
				sessionId: "session-1",
				messageId: result.messageId,
				type: "text",
				text: "READY",
			},
		]);
		expect(driverCalls).toEqual([
			{
				sessionId: "session-1",
				turnId: expect.any(String),
				assistantMessageId: result.messageId,
				prompt: [{ type: "text", text: "hello" }],
				dynamicConfig: {},
			},
		]);
		expect(events.map((event) => event.type)).toEqual([
			"session.created",
			"session.updated",
			"message.updated",
			"message.part.updated",
			"message.updated",
			"session.status",
			"message.part.updated",
			"message.part.delta",
			"message.updated",
			"session.status",
			"session.idle",
		]);
	});

	test("session.abort routes cancellation for the active session", async () => {
		const blocker = createDeferred();
		const cancelledTurnIds: string[] = [];
		const events: RuntimeEvent[] = [];
		const engine = new RuntimeEngine(
			{
				run: async () => {
					await blocker.promise;
					return undefined;
				},
				cancel: (turnId) => {
					cancelledTurnIds.push(turnId);
					return Promise.resolve();
				},
			},
			(event) => {
				events.push(event);
			}
		);

		await engine.session.create({
			sessionId: "session-1",
			agent: "claude",
			directory: "/workspace/repo",
			model: {
				providerID: "anthropic",
				modelID: "sonnet",
			},
		});

		const running = engine.session.prompt({
			sessionId: "session-1",
			parts: [{ type: "text", text: "wait" }],
		});

		expect(await engine.session.abort({ sessionId: "session-1" })).toBe(true);
		blocker.resolve();
		await running;

		expect(cancelledTurnIds).toEqual([expect.any(String)]);
		expect(events.some((event) => event.type === "session.idle")).toBe(true);
	});

	test("permission.reply resolves using the stored permission id", async () => {
		const permissionInputs: Array<{
			requestId: string;
			outcome: unknown;
		}> = [];
		const engine = new RuntimeEngine(
			{
				run: (_input, emit) => {
					emit({
						type: "permission.requested",
						request: {
							id: "perm-1",
							sessionId: "session-1",
							permission: "Read file",
							options: [
								{
									kind: "allow_once",
									optionId: "opt-1",
									name: "Allow once",
								},
							],
							always: [],
							messageId: "msg-1",
							toolCallId: "tool-1",
						},
					});
					return Promise.resolve(undefined);
				},
				respondToPermissionRequest: (input) => {
					permissionInputs.push(input);
					return Promise.resolve(input.requestId === "perm-1");
				},
			},
			() => undefined
		);

		await engine.session.create({
			sessionId: "session-1",
			agent: "claude",
			directory: "/workspace/repo",
			model: {
				providerID: "anthropic",
				modelID: "sonnet",
			},
		});

		await engine.session.prompt({
			sessionId: "session-1",
			parts: [{ type: "text", text: "hello" }],
		});

		expect(
			await engine.permission.reply({
				requestId: "perm-1",
				reply: "once",
			})
		).toBe(true);

		expect(permissionInputs).toEqual([
			{
				requestId: "perm-1",
				outcome: {
					outcome: "selected",
					optionId: "opt-1",
				},
			},
		]);
	});
});
