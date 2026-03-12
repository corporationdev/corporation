import { describe, expect, test } from "bun:test";
import {
	type CreateSessionInput,
	type ResolvedStartTurnInput,
	RuntimeEngine,
} from "../index";
import type { RuntimeEvent } from "../runtime-events";

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

describe("RuntimeEngine", () => {
	test("creates a session and returns cloned config state", async () => {
		const driverCreates: CreateSessionInput[] = [];
		const engine = new RuntimeEngine(
			{
				createSession: (input) => {
					driverCreates.push(input);
					return Promise.resolve();
				},
				run: () => Promise.resolve(undefined),
			},
			() => undefined
		);

		const input: CreateSessionInput = {
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {
				modelId: "sonnet",
				configOptions: { effort: "high" },
			},
		};

		const created = await engine.createSession(input);
		input.staticConfig.agent = "codex";
		input.dynamicConfig.configOptions = { effort: "low" };

		expect(driverCreates).toEqual([
			{
				sessionId: "session-1",
				staticConfig: { agent: "claude", cwd: "/workspace/repo" },
				dynamicConfig: {
					modelId: "sonnet",
					configOptions: { effort: "high" },
				},
			},
		]);
		expect(created).toEqual({
			sessionId: "session-1",
			activeTurnId: null,
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {
				modelId: "sonnet",
				configOptions: { effort: "high" },
			},
		});
		expect(engine.getSession("session-1")).toEqual(created);
	});

	test("rejects a second turn while the same session is already running", async () => {
		const blocker = createDeferred();
		const events: RuntimeEvent[] = [];
		const driverCalls: ResolvedStartTurnInput[] = [];
		const engine = new RuntimeEngine(
			{
				run: async (input) => {
					driverCalls.push(input);
					await blocker.promise;
				},
			},
			(event) => {
				events.push(event);
			}
		);
		await engine.createSession({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {},
		});

		const firstTurn = engine.startTurn({
			sessionId: "session-1",
			prompt: [{ type: "text", text: "hello" }],
		});

		await expect(
			engine.startTurn({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "again" }],
			})
		).rejects.toThrow("Session session-1 already has active turn");

		blocker.resolve();
		const turnId = await firstTurn;

		expect(driverCalls).toEqual([
			{
				sessionId: "session-1",
				turnId,
				prompt: [{ type: "text", text: "hello" }],
				dynamicConfig: {},
			},
		]);
		expect(events).toEqual([
			{ type: "turn.started", sessionId: "session-1", turnId },
			{ type: "turn.completed", sessionId: "session-1", turnId },
		]);
	});

	test("applies config diffs before run and preserves them even if prompt execution fails", async () => {
		const configUpdates: Array<{ sessionId: string; dynamicConfig: unknown }> =
			[];
		const engine = new RuntimeEngine(
			{
				updateSessionConfig: (sessionId, dynamicConfig) => {
					configUpdates.push({ sessionId, dynamicConfig });
					return Promise.resolve();
				},
				run: () => Promise.reject(new Error("prompt failed")),
			},
			() => undefined
		);
		await engine.createSession({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {
				modelId: "sonnet",
				configOptions: { effort: "high", verbosity: "low" },
			},
		});

		await expect(
			engine.startTurn({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "switch" }],
				dynamicConfig: {
					modeId: "fast",
					configOptions: { effort: "medium" },
				},
			})
		).rejects.toThrow("prompt failed");

		expect(configUpdates).toEqual([
			{
				sessionId: "session-1",
				dynamicConfig: {
					modeId: "fast",
					configOptions: { effort: "medium" },
				},
			},
		]);
		expect(engine.getSession("session-1")).toEqual({
			sessionId: "session-1",
			activeTurnId: null,
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {
				modelId: "sonnet",
				modeId: "fast",
				configOptions: { effort: "medium", verbosity: "low" },
			},
		});
	});

	test("does not mutate session config if applying the diff fails", async () => {
		const engine = new RuntimeEngine(
			{
				updateSessionConfig: () => Promise.reject(new Error("config failed")),
				run: () => Promise.resolve(undefined),
			},
			() => undefined
		);
		await engine.createSession({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {
				modelId: "sonnet",
				configOptions: { effort: "high", verbosity: "low" },
			},
		});

		await expect(
			engine.startTurn({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "switch" }],
				dynamicConfig: {
					modeId: "fast",
					configOptions: { effort: "medium" },
				},
			})
		).rejects.toThrow("config failed");

		expect(engine.getSession("session-1")).toEqual({
			sessionId: "session-1",
			activeTurnId: null,
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {
				modelId: "sonnet",
				configOptions: { effort: "high", verbosity: "low" },
			},
		});
	});

	test("routes cancellation to the driver for an active turn", async () => {
		const blocker = createDeferred();
		const cancelledTurnIds: string[] = [];
		const engine = new RuntimeEngine(
			{
				run: async () => {
					await blocker.promise;
				},
				cancel: (turnId) => {
					cancelledTurnIds.push(turnId);
					return Promise.resolve();
				},
			},
			() => undefined
		);
		await engine.createSession({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {},
		});

		const turnPromise = engine.startTurn({
			sessionId: "session-1",
			prompt: [{ type: "text", text: "wait" }],
		});
		const turnId = engine.getActiveTurnId("session-1");
		expect(turnId).toBeString();
		const runningTurnId = turnId as string;

		expect(await engine.cancelTurn(runningTurnId)).toBe(true);
		blocker.resolve();
		await turnPromise;

		expect(cancelledTurnIds).toEqual([runningTurnId]);
		expect(engine.getTurn(runningTurnId)?.status).toBe("cancelled");
	});
});
