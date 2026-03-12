import { describe, expect, test } from "bun:test";
import {
	AGENT_METHODS,
	type PromptResponse,
} from "@agentclientprotocol/sdk";
import {
	type AcpInboundEvent,
	type AcpConnection,
	type AcpConnectionFactory,
	type AcpRequestMap,
	type AcpRequestMethod,
	createAcpDriver,
} from "../acp-driver";

type RequestCall = {
	method: string;
	params: unknown;
};

function createFakeConnection(sessionId: string) {
	const requestCalls: RequestCall[] = [];
	const notifyCalls: RequestCall[] = [];
	const listeners = new Set<(event: AcpInboundEvent) => void>();
	const connection: AcpConnection = {
		request<M extends AcpRequestMethod>(
			method: M,
			params: AcpRequestMap[M]["params"]
		): Promise<AcpRequestMap[M]["result"]> {
			requestCalls.push({ method, params });
			switch (method) {
				case "initialize":
					return Promise.resolve({} as AcpRequestMap[M]["result"]);
				case "session/new":
					return Promise.resolve({ sessionId } as AcpRequestMap[M]["result"]);
				case AGENT_METHODS.session_prompt:
					return Promise.resolve({
						stopReason: "end_turn",
					} as AcpRequestMap[M]["result"]);
				default:
					return Promise.resolve({} as AcpRequestMap[M]["result"]);
			}
		},
		notify(method, params) {
			notifyCalls.push({ method, params });
			return Promise.resolve();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};

	return {
		connection,
		requestCalls,
		notifyCalls,
		emit(event: AcpInboundEvent) {
			for (const listener of listeners) {
				listener(event);
			}
		},
	};
}

describe("createAcpDriver", () => {
	test("creates one ACP session on createSession and applies initial config", async () => {
		const fake = createFakeConnection("acp-1");
		const factory: AcpConnectionFactory = {
			connect() {
				return Promise.resolve(fake.connection);
			},
		};
		const driver = createAcpDriver(factory);

		await driver.createSession?.({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {
				modelId: "sonnet",
				modeId: "fast",
				configOptions: { effort: "high" },
			},
		});

		expect(fake.requestCalls).toEqual([
			{
				method: "initialize",
				params: {
					protocolVersion: 2,
					clientInfo: { name: "sandbox-runtime", version: "v1" },
				},
			},
			{
				method: "session/new",
				params: {
					cwd: "/workspace/repo",
					mcpServers: [],
				},
			},
			{
				method: AGENT_METHODS.session_set_model,
				params: { sessionId: "acp-1", modelId: "sonnet" },
			},
			{
				method: AGENT_METHODS.session_set_mode,
				params: { sessionId: "acp-1", modeId: "fast" },
			},
			{
				method: AGENT_METHODS.session_set_config_option,
				params: {
					sessionId: "acp-1",
					configId: "effort",
					value: "high",
				},
			},
		]);
	});

	test("run applies only the provided dynamic diff and then prompts", async () => {
		const fake = createFakeConnection("acp-1");
		const driver = createAcpDriver({
			connect() {
				return Promise.resolve(fake.connection);
			},
		});
		await driver.createSession?.({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: { modelId: "sonnet" },
		});
		fake.requestCalls.length = 0;

		await driver.run(
			{
				sessionId: "session-1",
				turnId: "turn-1",
				prompt: [{ type: "text", text: "hello" }],
				dynamicConfig: {
					modeId: "fast",
					configOptions: { effort: "high" },
				},
			},
			() => undefined
		);

		expect(fake.requestCalls).toEqual([
			{
				method: AGENT_METHODS.session_set_mode,
				params: { sessionId: "acp-1", modeId: "fast" },
			},
			{
				method: AGENT_METHODS.session_set_config_option,
				params: {
					sessionId: "acp-1",
					configId: "effort",
					value: "high",
				},
			},
			{
				method: AGENT_METHODS.session_prompt,
				params: {
					sessionId: "acp-1",
					prompt: [{ type: "text", text: "hello" }],
				},
			},
		]);
	});

	test("run maps ACP inbound events into normalized runtime events", async () => {
		const fake = createFakeConnection("acp-1");
		const events: unknown[] = [];
		let releasePrompt!: () => void;
		const promptFinished = new Promise<PromptResponse>((resolve) => {
			releasePrompt = () => {
				resolve({ stopReason: "end_turn" });
			};
		});
		fake.connection.request = <M extends AcpRequestMethod>(
			method: M,
			params: AcpRequestMap[M]["params"]
		): Promise<AcpRequestMap[M]["result"]> => {
			fake.requestCalls.push({ method, params });
			switch (method) {
				case "initialize":
					return Promise.resolve({} as AcpRequestMap[M]["result"]);
				case "session/new":
					return Promise.resolve({ sessionId: "acp-1" } as AcpRequestMap[M]["result"]);
				case AGENT_METHODS.session_prompt:
					fake.emit({
						type: "session_update",
						notification: {
							sessionId: "acp-1",
							update: {
								sessionUpdate: "agent_message_chunk",
								content: {
									type: "text",
									text: "READY",
								},
							},
						},
					});
					fake.emit({
						type: "session_update",
						notification: {
							sessionId: "acp-1",
							update: {
								sessionUpdate: "plan",
								entries: [
									{
										content: "Answer the user",
										priority: "high",
										status: "in_progress",
									},
								],
							},
						},
					});
					fake.emit({
						type: "session_update",
						notification: {
							sessionId: "acp-1",
							update: {
								sessionUpdate: "current_mode_update",
								currentModeId: "fast",
							},
						},
					});
					fake.emit({
						type: "session_update",
						notification: {
							sessionId: "acp-1",
							update: {
								sessionUpdate: "config_option_update",
								configOptions: [
									{
										type: "select",
										id: "effort",
										name: "Effort",
										currentValue: "high",
										options: [{ name: "High", value: "high" }],
									},
								],
							},
						},
					});
					fake.emit({
						type: "session_update",
						notification: {
							sessionId: "acp-1",
							update: {
								sessionUpdate: "session_info_update",
								title: "Session title",
								updatedAt: "2026-03-12T12:00:00Z",
							},
						},
					});
					fake.emit({
						type: "session_update",
						notification: {
							sessionId: "acp-1",
							update: {
								sessionUpdate: "usage_update",
								used: 50,
								size: 100,
								cost: { amount: 0.01, currency: "USD" },
							},
						},
					});
					fake.emit({
						type: "permission_request",
						requestId: "perm-1",
						request: {
							sessionId: "acp-1",
							options: [{ kind: "allow_once", optionId: "opt-1", name: "Allow once" }],
							toolCall: {
								toolCallId: "tool-1",
								title: "Read file",
								status: "pending",
							},
						},
					});
					return promptFinished.then(
						(result) => result as AcpRequestMap[M]["result"]
					);
				default:
					return Promise.resolve({} as AcpRequestMap[M]["result"]);
			}
		};

		const driver = createAcpDriver({
			connect() {
				return Promise.resolve(fake.connection);
			},
		});
		await driver.createSession?.({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {},
		});

		const running = driver.run(
			{
				sessionId: "session-1",
				turnId: "turn-1",
				prompt: [{ type: "text", text: "hello" }],
				dynamicConfig: {},
			},
			(event) => {
				events.push(event);
			}
		);

		releasePrompt();
		const result = await running;

		expect(result).toEqual({ stopReason: "end_turn" });
		expect(events).toEqual([
			{
				type: "output.delta",
				sessionId: "session-1",
				turnId: "turn-1",
				channel: "assistant",
				content: {
					type: "text",
					text: "READY",
				},
			},
			{
				type: "plan.updated",
				sessionId: "session-1",
				turnId: "turn-1",
				entries: [
					{
						content: "Answer the user",
						priority: "high",
						status: "in_progress",
					},
				],
			},
			{
				type: "session.mode.updated",
				sessionId: "session-1",
				turnId: "turn-1",
				modeId: "fast",
			},
			{
				type: "session.config.updated",
				sessionId: "session-1",
				turnId: "turn-1",
				configOptions: [
					{
						type: "select",
						id: "effort",
						name: "Effort",
						currentValue: "high",
						options: [{ name: "High", value: "high" }],
					},
				],
			},
			{
				type: "session.info.updated",
				sessionId: "session-1",
				turnId: "turn-1",
				title: "Session title",
				updatedAt: "2026-03-12T12:00:00Z",
			},
			{
				type: "usage.updated",
				sessionId: "session-1",
				turnId: "turn-1",
				used: 50,
				size: 100,
				cost: { amount: 0.01, currency: "USD" },
			},
			{
				type: "permission.requested",
				sessionId: "session-1",
				turnId: "turn-1",
				requestId: "perm-1",
				options: [{ kind: "allow_once", optionId: "opt-1", name: "Allow once" }],
				toolCall: {
					toolCallId: "tool-1",
					title: "Read file",
					status: "pending",
				},
			},
		]);
	});

	test("cancel routes to the ACP session for the active turn only", async () => {
		const fake = createFakeConnection("acp-1");
		let releasePrompt!: () => void;
		const promptFinished = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		fake.connection.request = async <M extends AcpRequestMethod>(
			method: M,
			params: AcpRequestMap[M]["params"]
		): Promise<AcpRequestMap[M]["result"]> => {
			fake.requestCalls.push({ method, params });
			switch (method) {
				case "initialize":
					return {} as AcpRequestMap[M]["result"];
				case "session/new":
					return { sessionId: "acp-1" } as AcpRequestMap[M]["result"];
				case AGENT_METHODS.session_prompt:
					await promptFinished;
					return {} as AcpRequestMap[M]["result"];
				default:
					return {} as AcpRequestMap[M]["result"];
			}
		};

		const driver = createAcpDriver({
			connect() {
				return Promise.resolve(fake.connection);
			},
		});
		await driver.createSession?.({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: {},
		});

		const running = driver.run(
			{
				sessionId: "session-1",
				turnId: "turn-1",
				prompt: [{ type: "text", text: "wait" }],
				dynamicConfig: {},
			},
			() => undefined
		);

		await driver.cancel?.("turn-1");
		await driver.cancel?.("turn-2");
		releasePrompt();
		await running;

		expect(fake.notifyCalls).toEqual([
			{
				method: AGENT_METHODS.session_cancel,
				params: { sessionId: "acp-1" },
			},
		]);
	});
});
