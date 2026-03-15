import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@tendril/contracts/session-event";
import {
	type CreateSessionInput,
	type ResolvedStartTurnInput,
	RuntimeEngine,
} from "../agent-runtime";

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

describe("RuntimeEngine", () => {
	test("creates a session and returns flattened state", async () => {
		const driverCalls: unknown[] = [];
		const engine = new RuntimeEngine(
			{
				createSession: (input) => {
					driverCalls.push(input);
					return Promise.resolve();
				},
				run: () => Promise.resolve(undefined),
			},
			() => undefined
		);

		const input: CreateSessionInput = {
			sessionId: "session-1",
			agent: "claude",
			cwd: "/workspace/repo",
			model: "sonnet",
			configOptions: { effort: "high" },
		};

		const created = await engine.createSession(input);
		input.agent = "codex";
		input.configOptions = { effort: "low" };

		expect(driverCalls).toEqual([
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
			agent: "claude",
			cwd: "/workspace/repo",
			model: "sonnet",
			configOptions: { effort: "high" },
		});
		expect(engine.getSession("session-1")).toEqual(created);
	});

	test("rejects a second prompt while the same session is already running", async () => {
		const blocker = createDeferred();
		const events: SessionEvent[] = [];
		const driverCalls: ResolvedStartTurnInput[] = [];
		const engine = new RuntimeEngine(
			{
				run: async (input) => {
					driverCalls.push(input);
					await blocker.promise;
					return undefined;
				},
			},
			(event) => {
				events.push(event);
			}
		);
		await engine.createSession({
			sessionId: "session-1",
			agent: "claude",
			cwd: "/workspace/repo",
		});

		const firstTurn = engine.prompt({
			sessionId: "session-1",
			prompt: [{ type: "text", text: "hello" }],
		});

		await expect(
			engine.prompt({
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
			{
				kind: "text_delta",
				sessionId: "session-1",
				channel: "user",
				content: {
					type: "text",
					text: "hello",
				},
			},
			{ kind: "status", sessionId: "session-1", status: "running" },
			{ kind: "status", sessionId: "session-1", status: "idle" },
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
			agent: "claude",
			cwd: "/workspace/repo",
			model: "sonnet",
			configOptions: { effort: "high", verbosity: "low" },
		});

		await expect(
			engine.prompt({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "switch" }],
				mode: "fast",
				configOptions: { effort: "medium" },
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
			agent: "claude",
			cwd: "/workspace/repo",
			model: "sonnet",
			mode: "fast",
			configOptions: { effort: "medium", verbosity: "low" },
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
			agent: "claude",
			cwd: "/workspace/repo",
			model: "sonnet",
			configOptions: { effort: "high", verbosity: "low" },
		});

		await expect(
			engine.prompt({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "switch" }],
				mode: "fast",
				configOptions: { effort: "medium" },
			})
		).rejects.toThrow("config failed");

		expect(engine.getSession("session-1")).toEqual({
			sessionId: "session-1",
			activeTurnId: null,
			agent: "claude",
			cwd: "/workspace/repo",
			model: "sonnet",
			configOptions: { effort: "high", verbosity: "low" },
		});
	});

	test("routes abort to the driver for an active session", async () => {
		const blocker = createDeferred();
		const cancelledTurnIds: string[] = [];
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
			() => undefined
		);
		await engine.createSession({
			sessionId: "session-1",
			agent: "claude",
			cwd: "/workspace/repo",
		});

		const turnPromise = engine.prompt({
			sessionId: "session-1",
			prompt: [{ type: "text", text: "wait" }],
		});
		const turnId = engine.getActiveTurnId("session-1");
		expect(turnId).toBeString();
		const runningTurnId = turnId as string;

		expect(await engine.abort("session-1")).toBe(true);
		blocker.resolve();
		await turnPromise;

		expect(cancelledTurnIds).toEqual([runningTurnId]);
		expect(engine.getTurn(runningTurnId)?.status).toBe("cancelled");
	});

	test("delegates permission responses to the driver", async () => {
		const permissionInputs: Array<{
			requestId: string;
			outcome: unknown;
		}> = [];
		const engine = new RuntimeEngine(
			{
				run: () => Promise.resolve(undefined),
				respondToPermissionRequest: (input) => {
					permissionInputs.push(input);
					return Promise.resolve(input.requestId === "perm-1");
				},
			},
			() => undefined
		);

		expect(
			await engine.respondToPermission({
				requestId: "perm-1",
				outcome: { outcome: "selected", optionId: "opt-1" },
			})
		).toBe(true);
		expect(
			await engine.respondToPermission({
				requestId: "missing",
				outcome: { outcome: "cancelled" },
			})
		).toBe(false);

		expect(permissionInputs).toEqual([
			{
				requestId: "perm-1",
				outcome: { outcome: "selected", optionId: "opt-1" },
			},
			{
				requestId: "missing",
				outcome: { outcome: "cancelled" },
			},
		]);
	});
});
