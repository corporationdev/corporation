import crypto from "node:crypto";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import type {
	AgentProbeAgent,
	AgentProbeRequestBody,
	AgentProbeResponse,
} from "@corporation/contracts/sandbox-do";
import { isAgentInstalled, runtimeAgentEntries } from "./agents";
import { ACP_PROTOCOL_VERSION } from "./helpers";
import { log } from "./logging";
import { spawnStdioBridge, stdioRequest, teardownBridge } from "./stdio-bridge";

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 9;
const ACP_ERROR_CODE_REGEX = /acp error \((-?\d+)\):/i;
const PROBE_CWD = "/workspace";

type RuntimeAgentEntry = ReturnType<typeof runtimeAgentEntries>[number];

type VerifiedProbeEntry = {
	verifiedAt: number;
};

type ProbeState = {
	verifiedProbeByAgent: Map<string, VerifiedProbeEntry>;
	inFlightProbeByAgent: Map<string, Promise<AgentProbeAgent>>;
};

function buildProbeAgentBase(params: {
	id: string;
	name: string;
}): AgentProbeAgent {
	return {
		id: params.id,
		name: params.name,
		status: "not_installed",
		configOptions: null,
		verifiedAt: null,
		authCheckedAt: null,
		error: null,
	};
}

function getAcpErrorCode(error: unknown): number | null {
	const message = error instanceof Error ? error.message : String(error);
	const match = ACP_ERROR_CODE_REGEX.exec(message);
	const code = match?.[1];
	if (!code) {
		return null;
	}

	return Number.parseInt(code, 10);
}

export function isAuthRequiredError(error: unknown): boolean {
	if (getAcpErrorCode(error) === -32_000) {
		return true;
	}

	const message = (error instanceof Error ? error.message : String(error))
		.toLowerCase()
		.trim();
	return (
		message.includes("auth_required") ||
		message.includes("authentication required") ||
		message.includes("requires authentication") ||
		message.includes("requires auth") ||
		message.includes("api key must be set") ||
		message.includes("missing api key") ||
		message.includes("api key is required") ||
		message.includes("no api key") ||
		message.includes("unauthorized") ||
		message.includes("unauthenticated")
	);
}

function getAbortError(signal: AbortSignal, fallback: string): Error {
	const reason = signal.reason;
	if (reason instanceof Error) {
		return reason;
	}
	if (typeof reason === "string" && reason.length > 0) {
		return new Error(reason);
	}
	return new Error(fallback);
}

async function sleepWithSignal(
	durationMs: number,
	signal?: AbortSignal
): Promise<void> {
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, durationMs));
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(getAbortError(signal, "Probe startup aborted"));
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, durationMs);
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};

		if (signal.aborted) {
			onAbort();
			return;
		}

		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function withTimeout<T>(
	run: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	label: string
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

function isUnsupportedMethodError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return msg.includes("(-32601)");
}

async function setProbeModelOrThrow(
	bridge: ReturnType<typeof spawnStdioBridge>,
	agentSessionId: string,
	modelId: string,
	options?: {
		signal?: AbortSignal;
		timeoutMs?: number;
	}
): Promise<void> {
	try {
		await stdioRequest(
			bridge,
			AGENT_METHODS.session_set_model,
			{
				sessionId: agentSessionId,
				modelId,
			},
			options
		);
	} catch (error) {
		if (isUnsupportedMethodError(error)) {
			log("warn", "session/set_model not supported by agent during probe", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		throw error;
	}
}

async function runVerificationPrompt(params: {
	entry: RuntimeAgentEntry;
	bridge: ReturnType<typeof spawnStdioBridge>;
	agentSessionId: string;
	currentModelId: string | null;
	signal?: AbortSignal;
	state: ProbeState;
}): Promise<void> {
	const { entry, bridge, agentSessionId, currentModelId, signal, state } =
		params;

	if (currentModelId) {
		await setProbeModelOrThrow(bridge, agentSessionId, currentModelId, {
			timeoutMs: PROBE_TIMEOUT_MS,
			signal,
		});
	}

	await stdioRequest(
		bridge,
		AGENT_METHODS.session_prompt,
		{
			sessionId: agentSessionId,
			prompt: [{ type: "text", text: "Reply with OK." }],
		},
		{ timeoutMs: PROBE_TIMEOUT_MS, signal }
	);

	state.verifiedProbeByAgent.set(entry.id, {
		verifiedAt: Date.now(),
	});
}

async function probeSingleAgent(
	entry: RuntimeAgentEntry,
	state: ProbeState,
	signal?: AbortSignal
): Promise<AgentProbeAgent> {
	const base = buildProbeAgentBase({
		id: entry.id,
		name: entry.name,
	});
	const authCheckedAt = Date.now();

	if (!isAgentInstalled(entry.id)) {
		return {
			...base,
			authCheckedAt,
		};
	}

	const bridge = spawnStdioBridge(entry.id, () => undefined);
	const probeSessionId = `probe-${entry.id}-${crypto.randomUUID()}`;
	let bridgeTornDown = false;
	const closeBridge = (reason: string) => {
		if (bridgeTornDown) {
			return;
		}
		bridgeTornDown = true;
		teardownBridge(bridge, {
			agent: entry.id,
			sessionId: probeSessionId,
			reason,
		});
	};
	const onAbort = () => {
		if (!signal) {
			return;
		}
		closeBridge(getAbortError(signal, `Probe for ${entry.id} aborted`).message);
	};

	if (signal?.aborted) {
		onAbort();
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}

	try {
		await sleepWithSignal(250, signal);
		if (bridge.proc.exitCode !== null) {
			throw new Error(
				`Agent ${entry.id} exited immediately with code ${bridge.proc.exitCode}`
			);
		}

		await stdioRequest<"initialize">(
			bridge,
			"initialize",
			{
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientInfo: { name: "sandbox-runtime", version: "v1" },
			},
			{ timeoutMs: PROBE_TIMEOUT_MS, signal }
		);

		const sessionResult = await stdioRequest<"session/new">(
			bridge,
			"session/new",
			{ cwd: PROBE_CWD, mcpServers: [] },
			{ timeoutMs: PROBE_TIMEOUT_MS, signal }
		);
		const configOptions = sessionResult.configOptions ?? [];
		const cached = state.verifiedProbeByAgent.get(entry.id);

		if (cached) {
			return {
				...base,
				status: "verified",
				configOptions,
				verifiedAt: cached.verifiedAt,
				authCheckedAt,
			};
		}

		await runVerificationPrompt({
			entry,
			bridge,
			agentSessionId: sessionResult.sessionId,
			currentModelId: sessionResult.models?.currentModelId ?? null,
			signal,
			state,
		});

		return {
			...base,
			status: "verified",
			configOptions,
			verifiedAt: state.verifiedProbeByAgent.get(entry.id)?.verifiedAt ?? null,
			authCheckedAt,
		};
	} catch (error) {
		state.verifiedProbeByAgent.delete(entry.id);

		if (signal?.aborted) {
			throw getAbortError(signal, `Probe for ${entry.id} aborted`);
		}

		if (isAuthRequiredError(error)) {
			return {
				...base,
				status: "requires_auth",
				authCheckedAt,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		return {
			...base,
			status: "error",
			authCheckedAt,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		signal?.removeEventListener("abort", onAbort);
		closeBridge("agent probe completed");
	}
}

function getOrCreateProbePromise(
	entry: RuntimeAgentEntry,
	state: ProbeState
): Promise<AgentProbeAgent> {
	const existing = state.inFlightProbeByAgent.get(entry.id);
	if (existing) {
		return existing;
	}

	const promise = withTimeout(
		(signal) => probeSingleAgent(entry, state, signal),
		PROBE_TIMEOUT_MS,
		`Probe for ${entry.id}`
	).finally(() => {
		if (state.inFlightProbeByAgent.get(entry.id) === promise) {
			state.inFlightProbeByAgent.delete(entry.id);
		}
	});

	state.inFlightProbeByAgent.set(entry.id, promise);
	return promise;
}

export async function probeAgents(
	body: AgentProbeRequestBody,
	state: ProbeState
): Promise<AgentProbeResponse> {
	const entries = runtimeAgentEntries(body.ids);
	const results = new Array<AgentProbeAgent>(entries.length);
	let nextIndex = 0;

	const worker = async () => {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= entries.length) {
				return;
			}

			const entry = entries[index];
			if (!entry) {
				return;
			}

			results[index] = await getOrCreateProbePromise(entry, state).catch(
				(error) => ({
					...buildProbeAgentBase({
						id: entry.id,
						name: entry.name,
					}),
					status: "error" as const,
					authCheckedAt: Date.now(),
					error: error instanceof Error ? error.message : String(error),
				})
			);
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(PROBE_CONCURRENCY, entries.length) }, () =>
			worker()
		)
	);

	log("info", "Completed agent probe batch", {
		count: results.length,
		cwd: PROBE_CWD,
	});

	return {
		probedAt: Date.now(),
		agents: results,
	};
}
