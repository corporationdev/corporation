import { describe, expect, test } from "bun:test";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import {
	type AcpConnection,
	type AcpConnectionFactory,
	type AcpRequestMap,
	type AcpRequestMethod,
	createAcpDriver,
} from "../acp-session-manager";

type RequestCall = {
	method: string;
	params: unknown;
};

function createFakeConnection(sessionId: string) {
	const requestCalls: RequestCall[] = [];
	const notifyCalls: RequestCall[] = [];
	const connection: AcpConnection = {
		async request<M extends AcpRequestMethod>(
			method: M,
			params: AcpRequestMap[M]["params"]
		): Promise<AcpRequestMap[M]["result"]> {
			requestCalls.push({ method, params });
			switch (method) {
				case "initialize":
					return {} as AcpRequestMap[M]["result"];
				case "session/new":
					return { sessionId } as AcpRequestMap[M]["result"];
				default:
					return {} as AcpRequestMap[M]["result"];
			}
		},
		async notify(method, params) {
			notifyCalls.push({ method, params });
		},
	};

	return { connection, requestCalls, notifyCalls };
}

describe("createAcpDriver", () => {
	test("creates one ACP session on createSession and applies initial config", async () => {
		const fake = createFakeConnection("acp-1");
		const factory: AcpConnectionFactory = {
			async connect() {
				return fake.connection;
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
			async connect() {
				return fake.connection;
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
			async connect() {
				return fake.connection;
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
