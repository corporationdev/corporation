import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { AGENT_METHODS, type PromptResponse } from "@agentclientprotocol/sdk";
import type { SessionEvent } from "@corporation/contracts/session-event";
import { createSpawnedAcpConnectionFactory } from "../acp-connection";
import {
	type AcpConnection,
	type AcpConnectionFactory,
	createAcpDriver,
} from "../acp-driver";
import { RuntimeEngine } from "../index";

const LIVE_AGENT = process.env.ACP_LIVE_AGENT?.trim();
const LIVE_MODEL = process.env.ACP_LIVE_MODEL?.trim();
const LIVE_CWD = process.env.ACP_LIVE_CWD?.trim() || process.cwd();

describe("RuntimeEngine Live", () => {
	if (LIVE_AGENT) {
		test("sends a real message and emits turn plus session events through the runtime engine", async () => {
			const baseFactory = createSpawnedAcpConnectionFactory();
			const liveConnections: AcpConnection[] = [];
			const events: SessionEvent[] = [];
			let promptResponse: PromptResponse | undefined;

			const recordingFactory: AcpConnectionFactory = {
				async connect(agent) {
					const connection = await baseFactory.connect(agent);
					liveConnections.push(connection);
					return {
						request(method, params) {
							return connection.request(method, params).then((result) => {
								if (method === AGENT_METHODS.session_prompt) {
									promptResponse = result as PromptResponse;
								}
								return result;
							});
						},
						notify(method, params) {
							return connection.notify(method, params);
						},
						respondToPermissionRequest(requestId, response) {
							return connection.respondToPermissionRequest(requestId, response);
						},
						subscribe(listener) {
							return connection.subscribe(listener);
						},
						close() {
							return connection.close?.() ?? Promise.resolve();
						},
					};
				},
			};

			const engine = new RuntimeEngine(
				createAcpDriver(recordingFactory),
				(event) => {
					events.push(event);
				}
			);
			const sessionId = `live-session-${crypto.randomUUID()}`;

			try {
				await engine.createSession({
					sessionId,
					agent: LIVE_AGENT,
					cwd: LIVE_CWD,
					...(LIVE_MODEL ? { model: LIVE_MODEL } : {}),
				});

				const turnId = await engine.prompt({
					sessionId,
					prompt: [
						{
							type: "text",
							text: "Reply with exactly the word READY. Do not use tools, do not read files, and do not request permissions.",
						},
					],
				});

				expect(turnId).toBeString();
				expect(engine.getTurn(turnId)?.status).toBe("completed");
				expect(events.length).toBeGreaterThanOrEqual(3);
				expect(events[0]).toEqual({
					kind: "status",
					sessionId,
					status: "running",
				});

				const streamedEvents = events.filter(
					(event) => event.kind !== "status"
				);
				expect(streamedEvents.length).toBeGreaterThan(0);
				expect(
					streamedEvents.some(
						(event) =>
							event.kind === "text_delta" &&
							event.channel === "assistant" &&
							event.content.type === "text" &&
							event.content.text.length > 0
					)
				).toBe(true);
				expect(events.at(-1)).toEqual({
					kind: "status",
					sessionId,
					status: "idle",
					stopReason: "end_turn",
				});
				expect(promptResponse).toBeDefined();
				expect(promptResponse?.stopReason).toBe("end_turn");
			} finally {
				await Promise.all(
					liveConnections.map(
						(connection) => connection.close?.() ?? Promise.resolve()
					)
				);
			}
		});
	} else {
		// biome-ignore lint/suspicious/noSkippedTests: this integration test is opt-in via ACP_LIVE_AGENT
		test.skip("sends a real message and emits turn plus session events through the runtime engine", () =>
			undefined);
	}
});
