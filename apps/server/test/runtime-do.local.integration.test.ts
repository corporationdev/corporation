import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@corporation/contracts/sandbox-do";
import { createHarness } from "./helpers/runtime-do-harness";

const SPACE_SLUG = "test-space";
const SANDBOX_ID = "sandbox-local";
const AGENT_ID = "claude-acp";
const MODEL_ID = "default";
const RUNTIME_DISCONNECTED_RE = /runtime is not connected/i;
const TIMED_OUT_RE = /timed out/i;

type Harness = Awaited<ReturnType<typeof createHarness>>;
type BrowserClient = Awaited<ReturnType<Harness["createBrowserClient"]>>;

function makeSessionEvent(sessionId: string, id: string): SessionEvent {
	return {
		id,
		connectionId: "runtime-connection-1",
		createdAt: Date.now(),
		eventIndex: 0,
		payload: {
			jsonrpc: "2.0",
			id,
			method: "session/prompt",
			params: {
				sessionId,
				prompt: [{ type: "text", text: "hello from test" }],
			},
		},
		sender: "client",
		sessionId,
	} as SessionEvent;
}

describe("Space DO runtime websocket integration (local worker)", () => {
	let harness: Harness;
	let browser: BrowserClient;

	beforeAll(async () => {
		harness = await createHarness();
		browser = await harness.createBrowserClient(SPACE_SLUG);
	});

	afterAll(async () => {
		browser?.close();
		await harness?.cleanup();
	});

	test("sendMessage fails fast when the runtime is disconnected", async () => {
		const sessionId = `session-${crypto.randomUUID()}`;

		await expect(
			browser.client.sendMessage({
				sessionId,
				content: "Hello world",
				agent: AGENT_ID,
				modelId: MODEL_ID,
			})
		).rejects.toThrow(RUNTIME_DISCONNECTED_RE);

		const state = await harness.getSessionState(SPACE_SLUG, sessionId);
		expect(state.status).toBe("idle");
		expect(state.lastOffset).toBe(0);
	});

	test("sendMessage dispatches startTurn and completion clears running state", async () => {
		const runtime = await harness.createRuntime(SPACE_SLUG, SANDBOX_ID);
		const sessionId = `session-${crypto.randomUUID()}`;

		try {
			await browser.client.sendMessage({
				sessionId,
				content: "Say OK",
				agent: AGENT_ID,
				modelId: MODEL_ID,
			});

			const startTurn = await runtime.waitForCommand("start_turn");
			expect(startTurn.sessionId).toBe(sessionId);
			expect(startTurn.agent).toBe(AGENT_ID);
			expect(startTurn.modelId).toBe(MODEL_ID);

			const runningState = await harness.waitForSessionState(
				SPACE_SLUG,
				sessionId,
				(state) => state.status === "running",
				"session running state"
			);
			expect(runningState.status).toBe("running");

			await runtime.pushSessionEventBatch({
				type: "session_event_batch",
				turnId: startTurn.turnId,
				sessionId,
				events: [makeSessionEvent(sessionId, `event-${crypto.randomUUID()}`)],
			});
			await runtime.completeTurn({
				type: "turn_completed",
				turnId: startTurn.turnId,
				sessionId,
			});

			const idleState = await harness.waitForSessionState(
				SPACE_SLUG,
				sessionId,
				(state) => state.status === "idle" && state.lastOffset >= 3,
				"session idle state after runtime completion"
			);
			expect(idleState.status).toBe("idle");
			expect(idleState.lastOffset).toBeGreaterThanOrEqual(3);

			const sessions = await harness.listSessions(browser);
			const session = sessions.find((row) => row.id === sessionId) ?? null;
			expect(session?.status).toBe("idle");
			expect(session?.runId).toBeNull();
		} finally {
			runtime.close();
		}
	});

	test("probeAgents resolves over the runtime websocket", async () => {
		const runtime = await harness.createRuntime(SPACE_SLUG, SANDBOX_ID);

		try {
			const probePromise = browser.client.getAgentProbeState();
			const probeRequest = await runtime.waitForCommand("probe_agents");
			await runtime.sendProbeResult({
				type: "probe_result",
				commandId: probeRequest.commandId,
				probedAt: Date.now(),
				agents: [
					{
						id: AGENT_ID,
						name: "Claude",
						status: "verified",
						configOptions: null,
						verifiedAt: null,
						authCheckedAt: Date.now(),
						error: null,
					},
				],
			});

			const result = await probePromise;
			expect(result.agents).toHaveLength(1);
			expect(result.agents[0]?.id).toBe(AGENT_ID);
			expect(result.agents[0]?.status).toBe("verified");
		} finally {
			runtime.close();
		}
	});

	test("runtime disconnect while a turn is running moves the session to error", async () => {
		const runtime = await harness.createRuntime(SPACE_SLUG, SANDBOX_ID);
		const sessionId = `session-${crypto.randomUUID()}`;

		try {
			await browser.client.sendMessage({
				sessionId,
				content: "Stay running",
				agent: AGENT_ID,
				modelId: MODEL_ID,
			});

			const startTurn = await runtime.waitForCommand("start_turn");
			expect(startTurn.sessionId).toBe(sessionId);

			await harness.waitForSessionState(
				SPACE_SLUG,
				sessionId,
				(state) => state.status === "running",
				"session running before runtime disconnect"
			);

			runtime.close("test disconnect");

			const errorState = await harness.waitForSessionState(
				SPACE_SLUG,
				sessionId,
				(state) =>
					state.status === "error" &&
					typeof state.error === "string" &&
					state.error.includes("Sandbox runtime disconnected"),
				"session error after runtime disconnect"
			);
			expect(errorState.status).toBe("error");
			expect(errorState.error).toContain("Sandbox runtime disconnected");
		} finally {
			runtime.close();
		}
	});

	test("the newest registered runtime socket supersedes the older one", async () => {
		const firstRuntime = await harness.createRuntime(SPACE_SLUG, SANDBOX_ID);
		const secondRuntime = await harness.createRuntime(SPACE_SLUG, SANDBOX_ID);
		const sessionId = `session-${crypto.randomUUID()}`;

		try {
			await browser.client.sendMessage({
				sessionId,
				content: "Route to the newest runtime",
				agent: AGENT_ID,
				modelId: MODEL_ID,
			});

			const startTurn = await secondRuntime.waitForCommand("start_turn");
			expect(startTurn.sessionId).toBe(sessionId);

			await expect(
				firstRuntime.waitForCommand("start_turn", 1000)
			).rejects.toThrow(TIMED_OUT_RE);
		} finally {
			firstRuntime.close();
			secondRuntime.close();
		}
	});
});
