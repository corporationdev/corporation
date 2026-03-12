import { describe, expect, test } from "bun:test";
import {
	type AgentDriver,
	RuntimeEngine,
	type RuntimeEvent,
	type ResolvedStartTurnInput,
} from "../index";

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

describe("RuntimeEngine", () => {
	test("ensureSession stores the initial session config", () => {
		const engine = new RuntimeEngine(
			{
				run: async () => undefined,
			},
			() => undefined
		);

		const session = engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				modelId: "sonnet",
				cwd: "/workspace/repo",
			},
		});

		expect(session).toEqual({
			sessionId: "session-1",
			activeTurnId: null,
			config: {
				agent: "claude",
				modelId: "sonnet",
				cwd: "/workspace/repo",
			},
		});
	});

	test("startTurn fails if the session has not been ensured", async () => {
		const engine = new RuntimeEngine(
			{
				run: async () => undefined,
			},
			() => undefined
		);

		await expect(
			engine.startTurn({
				sessionId: "session-1",
				turnId: "turn-1",
				prompt: [{ type: "text", text: "hello" }],
			})
		).rejects.toThrow("Session session-1 does not exist");
	});

	test("rejects a second turn while the same session is already running", async () => {
		const blocker = createDeferred();
		const events: RuntimeEvent[] = [];
		const driver: AgentDriver = {
			run: async () => {
				await blocker.promise;
			},
		};
		const engine = new RuntimeEngine(driver, (event) => {
			events.push(event);
		});
		engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				cwd: "/workspace/session-1",
			},
		});

		const firstTurn = engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: [{ type: "text", text: "hello" }],
		});

		expect(engine.getActiveTurnId("session-1")).toBe("turn-1");
		await expect(
			engine.startTurn({
				sessionId: "session-1",
				turnId: "turn-2",
				prompt: [{ type: "text", text: "again" }],
			})
		).rejects.toThrow(
			"Session session-1 already has active turn turn-1"
		);

		blocker.resolve();
		await firstTurn;

		expect(events).toEqual([
			{ type: "turn.started", sessionId: "session-1", turnId: "turn-1" },
			{ type: "turn.completed", sessionId: "session-1", turnId: "turn-1" },
		]);
		expect(engine.getActiveTurnId("session-1")).toBeNull();
		expect(engine.getTurn("turn-1")?.status).toBe("completed");
	});

	test("marks a running turn as cancelled and emits a cancelled event", async () => {
		const blocker = createDeferred();
		const events: RuntimeEvent[] = [];
		const cancelledTurnIds: string[] = [];
		const driver: AgentDriver = {
			run: async () => {
				await blocker.promise;
			},
			cancel: async (turnId) => {
				cancelledTurnIds.push(turnId);
			},
		};
		const engine = new RuntimeEngine(driver, (event) => {
			events.push(event);
		});
		engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				cwd: "/workspace/session-1",
			},
		});

		const runningTurn = engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: [{ type: "text", text: "cancel me" }],
		});

		expect(await engine.cancelTurn("turn-1")).toBe(true);
		expect(engine.getTurn("turn-1")?.status).toBe("cancelled");
		expect(cancelledTurnIds).toEqual(["turn-1"]);

		blocker.resolve();
		await runningTurn;

		expect(events).toEqual([
			{ type: "turn.started", sessionId: "session-1", turnId: "turn-1" },
			{ type: "turn.cancelled", sessionId: "session-1", turnId: "turn-1" },
		]);
		expect(engine.getActiveTurnId("session-1")).toBeNull();
	});

	test("emits failed and clears the active session turn when the driver throws", async () => {
		const events: RuntimeEvent[] = [];
		const driver: AgentDriver = {
			run: async () => {
				throw new Error("boom");
			},
		};
		const engine = new RuntimeEngine(driver, (event) => {
			events.push(event);
		});
		engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				cwd: "/workspace/session-1",
			},
		});

		await expect(
			engine.startTurn({
				sessionId: "session-1",
				turnId: "turn-1",
				prompt: [{ type: "text", text: "fail" }],
			})
		).rejects.toThrow("boom");

		expect(events).toEqual([
			{ type: "turn.started", sessionId: "session-1", turnId: "turn-1" },
			{
				type: "turn.failed",
				sessionId: "session-1",
				turnId: "turn-1",
				error: "boom",
			},
		]);
		expect(engine.getActiveTurnId("session-1")).toBeNull();
		expect(engine.getTurn("turn-1")?.status).toBe("failed");
	});

	test("returns false when cancelling an unknown turn", async () => {
		const engine = new RuntimeEngine(
			{
				run: async () => undefined,
			},
			() => undefined
		);

		expect(await engine.cancelTurn("missing-turn")).toBe(false);
	});

	test("returns false when cancelling a completed turn", async () => {
		const events: RuntimeEvent[] = [];
		const engine = new RuntimeEngine(
			{
				run: async () => undefined,
			},
			(event) => {
				events.push(event);
			}
		);
		engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				cwd: "/workspace/session-1",
			},
		});

		await engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: [{ type: "text", text: "done" }],
		});

		expect(await engine.cancelTurn("turn-1")).toBe(false);
		expect(engine.getTurn("turn-1")?.status).toBe("completed");
		expect(events).toEqual([
			{ type: "turn.started", sessionId: "session-1", turnId: "turn-1" },
			{ type: "turn.completed", sessionId: "session-1", turnId: "turn-1" },
		]);
	});

	test("allows different sessions to run at the same time", async () => {
		const first = createDeferred();
		const second = createDeferred();
		const events: RuntimeEvent[] = [];
		const blockers = new Map([
			["turn-1", first],
			["turn-2", second],
		]);
		const driver: AgentDriver = {
			run: async (input) => {
				const blocker = blockers.get(input.turnId);
				if (!blocker) {
					throw new Error(`Missing blocker for ${input.turnId}`);
				}
				await blocker.promise;
			},
		};
		const engine = new RuntimeEngine(driver, (event) => {
			events.push(event);
		});
		engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				cwd: "/workspace/session-1",
			},
		});
		engine.ensureSession({
			sessionId: "session-2",
			config: {
				agent: "codex",
				cwd: "/workspace/session-2",
			},
		});

		const firstTurn = engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: [{ type: "text", text: "first" }],
		});
		const secondTurn = engine.startTurn({
			sessionId: "session-2",
			turnId: "turn-2",
			prompt: [{ type: "text", text: "second" }],
		});

		expect(engine.getActiveTurnId("session-1")).toBe("turn-1");
		expect(engine.getActiveTurnId("session-2")).toBe("turn-2");

		first.resolve();
		second.resolve();
		await Promise.all([firstTurn, secondTurn]);

		expect(engine.getTurn("turn-1")?.status).toBe("completed");
		expect(engine.getTurn("turn-2")?.status).toBe("completed");
		expect(events).toEqual([
			{ type: "turn.started", sessionId: "session-1", turnId: "turn-1" },
			{ type: "turn.started", sessionId: "session-2", turnId: "turn-2" },
			{ type: "turn.completed", sessionId: "session-1", turnId: "turn-1" },
			{ type: "turn.completed", sessionId: "session-2", turnId: "turn-2" },
		]);
	});

	test("stores session config from startTurn and reuses it on later turns", async () => {
		const engine = new RuntimeEngine(
			{
				run: async () => undefined,
			},
			() => undefined
		);
		engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				modelId: "sonnet",
				cwd: "/workspace/repo",
			},
		});

		await engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: [{ type: "text", text: "first" }],
		});

		expect(engine.getSession("session-1")).toEqual({
			sessionId: "session-1",
			activeTurnId: null,
			config: {
				agent: "claude",
				modelId: "sonnet",
				cwd: "/workspace/repo",
			},
		});

		await engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-2",
			prompt: [{ type: "text", text: "second" }],
		});

		expect(engine.getSession("session-1")).toEqual({
			sessionId: "session-1",
			activeTurnId: null,
			config: {
				agent: "claude",
				modelId: "sonnet",
				cwd: "/workspace/repo",
			},
		});
	});

	test("merges later session config updates into the existing session state", async () => {
		const engine = new RuntimeEngine(
			{
				run: async () => undefined,
			},
			() => undefined
		);
		engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				modelId: "sonnet",
				cwd: "/workspace/repo",
			},
		});

		await engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: [{ type: "text", text: "first" }],
		});

		await engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-2",
			prompt: [{ type: "text", text: "second" }],
			configOverride: {
				modelId: "opus",
			},
		});

		expect(engine.getSession("session-1")).toEqual({
			sessionId: "session-1",
			activeTurnId: null,
			config: {
				agent: "claude",
				modelId: "opus",
				cwd: "/workspace/repo",
			},
		});
	});

	test("passes the resolved session config to the driver across turns", async () => {
		const calls: ResolvedStartTurnInput[] = [];
		const driver: AgentDriver = {
			run: async (input) => {
				calls.push(input);
			},
		};
		const engine = new RuntimeEngine(driver, () => undefined);
		engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				modelId: "sonnet",
				cwd: "/workspace/repo",
			},
		});

		await engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: [{ type: "text", text: "first" }],
		});

		await engine.startTurn({
			sessionId: "session-1",
			turnId: "turn-2",
			prompt: [{ type: "text", text: "second" }],
			configOverride: {
				modelId: "opus",
			},
		});

		expect(calls).toEqual([
			{
				sessionId: "session-1",
				turnId: "turn-1",
				prompt: [{ type: "text", text: "first" }],
				config: {
					agent: "claude",
					modelId: "sonnet",
					cwd: "/workspace/repo",
				},
			},
			{
				sessionId: "session-1",
				turnId: "turn-2",
				prompt: [{ type: "text", text: "second" }],
				config: {
					agent: "claude",
					modelId: "opus",
					cwd: "/workspace/repo",
				},
			},
		]);
	});

	test("startTurn rejects if an override makes the stored session config invalid", async () => {
		const driverCalls: ResolvedStartTurnInput[] = [];
		const driver: AgentDriver = {
			run: async (input) => {
				driverCalls.push(input);
			},
		};
		const events: RuntimeEvent[] = [];
		const engine = new RuntimeEngine(driver, (event) => {
			events.push(event);
		});
		engine.ensureSession({
			sessionId: "session-1",
			config: {
				agent: "claude",
				modelId: "sonnet",
				cwd: "/workspace/repo",
			},
		});

		await expect(
			engine.startTurn({
				sessionId: "session-1",
				turnId: "turn-1",
				prompt: [{ type: "text", text: "bad override" }],
				configOverride: {
					agent: undefined,
					cwd: undefined,
				},
			})
		).rejects.toThrow("Session session-1 has invalid config: agent and cwd are required");

		expect(driverCalls).toEqual([]);
		expect(events).toEqual([]);
		expect(engine.getSession("session-1")).toEqual({
			sessionId: "session-1",
			activeTurnId: null,
			config: {
				agent: "claude",
				modelId: "sonnet",
				cwd: "/workspace/repo",
			},
		});
		expect(engine.getTurn("turn-1")).toBeUndefined();
	});
});
