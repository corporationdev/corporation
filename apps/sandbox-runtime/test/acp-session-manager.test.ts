import { describe, expect, test } from "bun:test";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import {
	type AcpConnection,
	type AcpConnectionFactory,
	type AcpRequestMap,
	type AcpRequestMethod,
	AcpSessionManager,
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

	return {
		connection,
		requestCalls,
		notifyCalls,
	};
}

describe("AcpSessionManager", () => {
	test("creates one ACP session per runtime session and reuses the handle", async () => {
		const first = createFakeConnection("acp-1");
		const second = createFakeConnection("acp-2");
		const connections = [first, second];
		const factory: AcpConnectionFactory = {
			async connect() {
				const next = connections.shift();
				if (!next) {
					throw new Error("No fake ACP connection left");
				}
				return next.connection;
			},
		};
		const manager = new AcpSessionManager(factory);

		const firstHandle = await manager.getOrCreate({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo-a" },
			dynamicConfig: { modelId: "sonnet" },
		});
		const reusedHandle = await manager.getOrCreate({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo-a" },
			dynamicConfig: { modelId: "sonnet" },
		});
		const secondHandle = await manager.getOrCreate({
			sessionId: "session-2",
			staticConfig: { agent: "codex", cwd: "/workspace/repo-b" },
		});

		expect(reusedHandle).toBe(firstHandle);
		expect(firstHandle.getSnapshot()).toMatchObject({
			runtimeSessionId: "session-1",
			acpSessionId: "acp-1",
			appliedDynamic: { modelId: "sonnet" },
		});
		expect(secondHandle.getSnapshot()).toMatchObject({
			runtimeSessionId: "session-2",
			acpSessionId: "acp-2",
			appliedDynamic: {},
		});

		expect(first.requestCalls).toEqual([
			{
				method: "initialize",
				params: {
					protocolVersion: 2,
					clientInfo: {
						name: "sandbox-runtime",
						version: "v1",
					},
				},
			},
			{
				method: "session/new",
				params: {
					cwd: "/workspace/repo-a",
					mcpServers: [],
				},
			},
			{
				method: AGENT_METHODS.session_set_model,
				params: {
					sessionId: "acp-1",
					modelId: "sonnet",
				},
			},
		]);
		expect(second.requestCalls).toEqual([
			{
				method: "initialize",
				params: {
					protocolVersion: 2,
					clientInfo: {
						name: "sandbox-runtime",
						version: "v1",
					},
				},
			},
			{
				method: "session/new",
				params: {
					cwd: "/workspace/repo-b",
					mcpServers: [],
				},
			},
		]);
	});

	test("updates the ACP model on later turns but keeps the same ACP session", async () => {
		const fake = createFakeConnection("acp-1");
		const manager = new AcpSessionManager({
			async connect() {
				return fake.connection;
			},
		});
		const handle = await manager.getOrCreate({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: { modelId: "sonnet" },
		});

		await handle.runTurn(
			{
				sessionId: "session-1",
				turnId: "turn-1",
				prompt: [{ type: "text", text: "hello" }],
				dynamicConfig: { modelId: "sonnet" },
			},
			() => undefined
		);
		await handle.runTurn(
			{
				sessionId: "session-1",
				turnId: "turn-2",
				prompt: [{ type: "text", text: "switch models" }],
				dynamicConfig: { modelId: "opus" },
			},
			() => undefined
		);

		expect(fake.requestCalls).toEqual([
			{
				method: "initialize",
				params: {
					protocolVersion: 2,
					clientInfo: {
						name: "sandbox-runtime",
						version: "v1",
					},
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
				params: {
					sessionId: "acp-1",
					modelId: "sonnet",
				},
			},
			{
				method: AGENT_METHODS.session_prompt,
				params: {
					sessionId: "acp-1",
					prompt: [{ type: "text", text: "hello" }],
				},
			},
			{
				method: AGENT_METHODS.session_set_model,
				params: {
					sessionId: "acp-1",
					modelId: "opus",
				},
			},
			{
				method: AGENT_METHODS.session_prompt,
				params: {
					sessionId: "acp-1",
					prompt: [{ type: "text", text: "switch models" }],
				},
			},
		]);
		expect(handle.getSnapshot()).toMatchObject({
			runtimeSessionId: "session-1",
			acpSessionId: "acp-1",
			appliedDynamic: { modelId: "opus" },
		});
	});

	test("updates mode and config options between turns", async () => {
		const fake = createFakeConnection("acp-1");
		const manager = new AcpSessionManager({
			async connect() {
				return fake.connection;
			},
		});
		const handle = await manager.getOrCreate({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
			dynamicConfig: { modeId: "normal" },
		});

		await handle.runTurn(
			{
				sessionId: "session-1",
				turnId: "turn-1",
				prompt: [{ type: "text", text: "hello" }],
				dynamicConfig: {
					modeId: "fast",
					configOptions: { thought_level: "high" },
				},
			},
			() => undefined
		);

		// mode change + config option + prompt (skip init, session/new, initial modeId)
		const turnCalls = fake.requestCalls.slice(3);
		expect(turnCalls).toEqual([
			{
				method: AGENT_METHODS.session_set_mode,
				params: {
					sessionId: "acp-1",
					modeId: "fast",
				},
			},
			{
				method: AGENT_METHODS.session_set_config_option,
				params: {
					sessionId: "acp-1",
					configId: "thought_level",
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

		expect(handle.getSnapshot()).toMatchObject({
			appliedDynamic: {
				modeId: "fast",
				configOptions: { thought_level: "high" },
			},
		});
	});

	test("sends ACP session cancel without owning runtime turn bookkeeping", async () => {
		const fake = createFakeConnection("acp-1");
		const manager = new AcpSessionManager({
			async connect() {
				return fake.connection;
			},
		});
		const handle = await manager.getOrCreate({
			sessionId: "session-1",
			staticConfig: { agent: "claude", cwd: "/workspace/repo" },
		});

		await handle.cancelActiveTurn();

		expect(fake.notifyCalls).toEqual([
			{
				method: AGENT_METHODS.session_cancel,
				params: {
					sessionId: "acp-1",
				},
			},
		]);
	});
});
