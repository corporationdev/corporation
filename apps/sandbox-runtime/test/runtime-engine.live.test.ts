import crypto from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	AGENT_METHODS,
	type PromptResponse,
} from "@agentclientprotocol/sdk";
import { createSpawnedAcpConnectionFactory } from "../acp-connection";
import {
	type AcpConnection,
	type AcpConnectionFactory,
	createAcpDriver,
} from "../acp-session-manager";
import { RuntimeEngine, type RuntimeEvent } from "../index";

const LIVE_AGENT = process.env.ACP_LIVE_AGENT?.trim();
const LIVE_MODEL = process.env.ACP_LIVE_MODEL?.trim();
const LIVE_CWD = process.env.ACP_LIVE_CWD?.trim() || process.cwd();

describe("RuntimeEngine Live", () => {
	if (LIVE_AGENT) {
		test("creates a real ACP session and runs a real prompt through the runtime engine", async () => {
			const baseFactory = createSpawnedAcpConnectionFactory();
			const liveConnections: AcpConnection[] = [];
			const events: RuntimeEvent[] = [];
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
					staticConfig: {
						agent: LIVE_AGENT,
						cwd: LIVE_CWD,
					},
					dynamicConfig: LIVE_MODEL ? { modelId: LIVE_MODEL } : {},
				});

				const turnId = await engine.startTurn({
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
				expect(events).toEqual([
					{ type: "turn.started", sessionId, turnId },
					{ type: "turn.completed", sessionId, turnId },
				]);
				expect(promptResponse).toBeDefined();
				expect(promptResponse?.stopReason).toBe("end_turn");
			} finally {
				await Promise.all(
					liveConnections.map((connection) =>
						connection.close?.() ?? Promise.resolve()
					)
				);
			}
		});
	} else {
		// biome-ignore lint/suspicious/noSkippedTests: this integration test is opt-in via ACP_LIVE_AGENT
		test.skip(
			"creates a real ACP session and runs a real prompt through the runtime engine",
			() => undefined
		);
	}
});
