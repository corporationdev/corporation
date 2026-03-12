import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import { runtimeAgentEntry } from "../../src/agents";
import { ACP_PROTOCOL_VERSION } from "../../src/helpers";
import { spawnStdioBridge, stdioRequest, teardownBridge } from "../../src/stdio-bridge";

const ACP_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30_000;
const PROBE_CWD = "/workspace";

function sleep(durationMs: number) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function toErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function main() {
	const agentId = process.argv[2]?.trim();
	if (!agentId) {
		throw new Error("Missing agent id");
	}

	const entry = runtimeAgentEntry(agentId);
	if (!entry?.runtimeCommand) {
		throw new Error(`Unknown runtime agent: ${agentId}`);
	}

	const notifications: string[] = [];
	const envelopes: Array<Record<string, unknown>> = [];
	let failedStep: string | null = null;
	const bridge = spawnStdioBridge(
		agentId,
		(envelope) => {
			if ("method" in envelope && typeof envelope.method === "string") {
				notifications.push(envelope.method);
			}
		},
		(envelope, direction) => {
			envelopes.push({
				direction,
				id: "id" in envelope ? envelope.id ?? null : null,
				method: "method" in envelope ? envelope.method ?? null : null,
				hasResult: "result" in envelope,
				hasError: "error" in envelope,
			});
		}
	);

	try {
		await sleep(250);
		if (bridge.proc.exitCode !== null) {
			throw new Error(
				`Agent ${agentId} exited immediately with code ${bridge.proc.exitCode}`
			);
		}

		failedStep = "initialize";
		const initializeResult = await stdioRequest(
			bridge,
			"initialize",
			{
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientInfo: { name: "agent-auth-test", version: "v1" },
			},
			{ timeoutMs: ACP_TIMEOUT_MS }
		);

		failedStep = "session/new";
		const sessionResult = await stdioRequest(
			bridge,
			"session/new",
			{ cwd: PROBE_CWD, mcpServers: [] },
			{ timeoutMs: ACP_TIMEOUT_MS }
		);

		const currentModelId = sessionResult.models?.currentModelId ?? null;
		if (currentModelId) {
			failedStep = "session/set_model";
			try {
				await stdioRequest(
					bridge,
					AGENT_METHODS.session_set_model,
					{
						sessionId: sessionResult.sessionId,
						modelId: currentModelId,
					},
					{ timeoutMs: ACP_TIMEOUT_MS }
				);
			} catch (error) {
				const message = toErrorMessage(error);
				if (!message.includes("(-32601)")) {
					throw error;
				}
			}
		}

		failedStep = "session/prompt";
		const promptResult = await stdioRequest(
			bridge,
			AGENT_METHODS.session_prompt,
			{
				sessionId: sessionResult.sessionId,
				prompt: [{ type: "text", text: "Reply with OK." }],
			},
			{ timeoutMs: PROMPT_TIMEOUT_MS }
		);

		const result = {
			ok: true,
			agentId,
			initialize: initializeResult,
			sessionId: sessionResult.sessionId,
			configOptions: sessionResult.configOptions ?? [],
			currentModelId,
			notificationCount: notifications.length,
			notifications,
			envelopes,
			promptResult,
		};

		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	} catch (error) {
		const result = {
			ok: false,
			agentId,
			failedStep,
			error: toErrorMessage(error),
			notificationCount: notifications.length,
			notifications,
			envelopes,
			exitCode: bridge.proc.exitCode,
		};

		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	} finally {
		teardownBridge(bridge, {
			agent: agentId,
			sessionId: `probe-${agentId}`,
			reason: "agent auth smoke test completed",
		});
	}
}

await main();
