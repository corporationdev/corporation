import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { AGENT_METHODS, type PromptResponse } from "@agentclientprotocol/sdk";
import type {
	AssistantMessage,
	Event as RuntimeEvent,
	TextPart,
	UserMessage,
} from "@opencode-ai/sdk/v2";
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
		test("session.prompt emits OpenCode-shaped events through the runtime engine", async () => {
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
				const created = await engine.session.create({
					sessionId,
					agent: LIVE_AGENT,
					directory: LIVE_CWD,
					...(LIVE_MODEL
						? {
								model: {
									providerID: LIVE_AGENT,
									modelID: LIVE_MODEL,
								},
							}
						: {}),
				});

				const result = await engine.session.prompt({
					sessionId,
					parts: [
						{
							type: "text",
							text: "Reply with exactly the word READY. Do not use tools, do not read files, and do not request permissions.",
						},
					],
				});

				expect(created.id).toBe(sessionId);
				expect(result.sessionId).toBe(sessionId);
				expect(result.messageId).toEqual(expect.any(String));
				expect(result.completedAt).toEqual(expect.any(Number));
				expect(promptResponse?.stopReason).toBe("end_turn");

				expect(events[0]).toEqual({
					type: "session.created",
					properties: {
						info: {
							id: sessionId,
							slug: sessionId,
							projectID: LIVE_CWD,
							directory: LIVE_CWD,
							title: created.title,
							version: "v1",
							time: {
								created: expect.any(Number),
								updated: expect.any(Number),
							},
						},
					},
				});
				expect(events.some((event) => event.type === "session.updated")).toBe(
					true
				);
				expect(
					events.some(
						(event) =>
							event.type === "session.status" &&
							event.properties.sessionID === sessionId &&
							event.properties.status.type === "busy"
					)
				).toBe(true);
				expect(
					events.some(
						(event) =>
							event.type === "session.status" &&
							event.properties.sessionID === sessionId &&
							event.properties.status.type === "idle"
					)
				).toBe(true);
				expect(
					events.some(
						(event) =>
							event.type === "session.idle" &&
							event.properties.sessionID === sessionId
					)
				).toBe(true);

				const userMessages = events.filter(
					(
						event
					): event is Extract<RuntimeEvent, { type: "message.updated" }> =>
						event.type === "message.updated" &&
						event.properties.info.role === "user"
				);
				const assistantMessages = events.filter(
					(
						event
					): event is Extract<RuntimeEvent, { type: "message.updated" }> =>
						event.type === "message.updated" &&
						event.properties.info.role === "assistant"
				);
				const assistantParts = events.filter(
					(
						event
					): event is Extract<RuntimeEvent, { type: "message.part.updated" }> =>
						event.type === "message.part.updated" &&
						event.properties.part.messageID === result.messageId
				);

				expect(userMessages.length).toBeGreaterThanOrEqual(1);
				expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
				expect(assistantParts.length).toBeGreaterThan(0);
				expect(
					assistantParts.some(
						(event) =>
							event.properties.part.type === "text" &&
							event.properties.part.text.length > 0
					)
				).toBe(true);

				const finalAssistantMessage = assistantMessages.at(-1)?.properties
					.info as AssistantMessage | undefined;
				expect(finalAssistantMessage?.id).toBe(result.messageId);
				expect(finalAssistantMessage?.finish).toBe("end_turn");

				const userMessage = userMessages.at(-1)?.properties.info as
					| UserMessage
					| undefined;
				expect(userMessage?.sessionID).toBe(sessionId);
				expect(userMessage?.agent).toBe(LIVE_AGENT);

				const lastAssistantTextPart = assistantParts.findLast(
					(event) => event.properties.part.type === "text"
				)?.properties.part as TextPart | undefined;
				expect(lastAssistantTextPart).toBeDefined();
				expect(lastAssistantTextPart?.text.length).toBeGreaterThan(0);
				if (lastAssistantTextPart) {
					expect(result.parts).toContainEqual(lastAssistantTextPart);
				}
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
		test.skip("session.prompt emits OpenCode-shaped events through the runtime engine", () =>
			undefined);
	}
});
