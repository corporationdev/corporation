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
import type { AcpAgentRequestResult } from "./schemas";
import { spawnStdioBridge, stdioRequest, teardownBridge } from "./stdio-bridge";

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 9;
const ACP_ERROR_CODE_REGEX = /acp error \((-?\d+)\):/i;

type RuntimeAgentEntry = ReturnType<typeof runtimeAgentEntries>[number];

type VerifiedProbeEntry = {
	verifiedAt: number;
};

type ProbeState = {
	verifiedProbeByAgent: Map<string, VerifiedProbeEntry>;
	inFlightProbeByAgent: Map<string, Promise<AgentProbeAgent>>;
};

type ProbeModelsResult = {
	models: AgentProbeAgent["models"];
	defaultModelId: string | null;
};

function buildProbeAgentBase(params: {
	id: string;
	name: string;
}): AgentProbeAgent {
	return {
		id: params.id,
		name: params.name,
		status: "not_installed",
		models: [],
		defaultModelId: null,
		verifiedAt: null,
		authCheckedAt: null,
		error: null,
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

function flattenConfigOptionValues(
	options: unknown
): Array<{ value: string; name: string }> {
	if (!Array.isArray(options)) {
		return [];
	}

	const values: Array<{ value: string; name: string }> = [];
	for (const option of options) {
		if (!isObject(option)) {
			continue;
		}

		if (Array.isArray(option.options)) {
			values.push(...flattenConfigOptionValues(option.options));
			continue;
		}

		if (typeof option.value === "string" && typeof option.name === "string") {
			values.push({ value: option.value, name: option.name });
		}
	}

	return values;
}

function dedupeProbeModels(models: AgentProbeAgent["models"]) {
	const deduped: AgentProbeAgent["models"] = [];
	const seen = new Set<string>();

	for (const model of models) {
		if (seen.has(model.id)) {
			continue;
		}
		seen.add(model.id);
		deduped.push(model);
	}

	return deduped;
}

function normalizeConfigOptionModels(
	configOptions: AcpAgentRequestResult<
		typeof AGENT_METHODS.session_new
	>["configOptions"]
): ProbeModelsResult {
	const configModels: AgentProbeAgent["models"] = [];
	let defaultModelId: string | null = null;

	if (!Array.isArray(configOptions)) {
		return {
			models: [],
			defaultModelId,
		};
	}

	for (const option of configOptions) {
		if (!isObject(option) || option.category !== "model") {
			continue;
		}

		if (defaultModelId === null && typeof option.currentValue === "string") {
			defaultModelId = option.currentValue;
		}
		for (const model of flattenConfigOptionValues(option.options)) {
			configModels.push({
				id: model.value,
				name: model.name,
			});
		}
	}

	return {
		models: dedupeProbeModels(configModels),
		defaultModelId,
	};
}

function normalizeProbeModels(
	sessionResult: AcpAgentRequestResult<typeof AGENT_METHODS.session_new>
): ProbeModelsResult {
	const resultModels: AgentProbeAgent["models"] =
		sessionResult.models?.availableModels.map((model) => ({
			id: model.modelId,
			name: model.name,
		})) ?? [];
	const configModels = normalizeConfigOptionModels(sessionResult.configOptions);

	return {
		models: dedupeProbeModels([...resultModels, ...configModels.models]),
		defaultModelId:
			sessionResult.models?.currentModelId ??
			configModels.defaultModelId ??
			resultModels[0]?.id ??
			configModels.models[0]?.id ??
			null,
	};
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
	modelId: string
): Promise<void> {
	try {
		await stdioRequest(bridge, AGENT_METHODS.session_set_model, {
			sessionId: agentSessionId,
			modelId,
		});
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
	defaultModelId: string | null;
	signal?: AbortSignal;
	state: ProbeState;
}): Promise<void> {
	const { entry, bridge, agentSessionId, defaultModelId, signal, state } =
		params;

	if (defaultModelId) {
		await setProbeModelOrThrow(bridge, agentSessionId, defaultModelId);
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
	cwd: string,
	state: ProbeState,
	signal?: AbortSignal
): Promise<AgentProbeAgent> {
	const base = buildProbeAgentBase({
		id: entry.id,
		name: entry.name,
	});
	const authCheckedAt = Date.now();

	if (!isAgentInstalled(entry.runtimeId)) {
		return {
			...base,
			authCheckedAt,
		};
	}

	const bridge = spawnStdioBridge(entry.runtimeId, () => undefined);
	const probeSessionId = `probe-${entry.runtimeId}-${crypto.randomUUID()}`;
	let bridgeTornDown = false;
	const closeBridge = (reason: string) => {
		if (bridgeTornDown) {
			return;
		}
		bridgeTornDown = true;
		teardownBridge(bridge, {
			agent: entry.runtimeId,
			sessionId: probeSessionId,
			reason,
		});
	};
	const onAbort = () => {
		if (!signal) {
			return;
		}
		closeBridge(
			getAbortError(signal, `Probe for ${entry.runtimeId} aborted`).message
		);
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
				`Agent ${entry.runtimeId} exited immediately with code ${bridge.proc.exitCode}`
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
			{ cwd, mcpServers: [] },
			{ timeoutMs: PROBE_TIMEOUT_MS, signal }
		);
		const normalizedModels = normalizeProbeModels(sessionResult);
		const cached = state.verifiedProbeByAgent.get(entry.id);

		if (cached) {
			return {
				...base,
				status: "verified",
				models: normalizedModels.models,
				defaultModelId: normalizedModels.defaultModelId,
				verifiedAt: cached.verifiedAt,
				authCheckedAt,
			};
		}

		await runVerificationPrompt({
			entry,
			bridge,
			agentSessionId: sessionResult.sessionId,
			defaultModelId: normalizedModels.defaultModelId,
			signal,
			state,
		});

		return {
			...base,
			status: "verified",
			models: normalizedModels.models,
			defaultModelId: normalizedModels.defaultModelId,
			verifiedAt: state.verifiedProbeByAgent.get(entry.id)?.verifiedAt ?? null,
			authCheckedAt,
		};
	} catch (error) {
		state.verifiedProbeByAgent.delete(entry.id);

		if (signal?.aborted) {
			throw getAbortError(signal, `Probe for ${entry.runtimeId} aborted`);
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
	cwd: string,
	state: ProbeState
): Promise<AgentProbeAgent> {
	const existing = state.inFlightProbeByAgent.get(entry.id);
	if (existing) {
		return existing;
	}

	const promise = withTimeout(
		(signal) => probeSingleAgent(entry, cwd, state, signal),
		PROBE_TIMEOUT_MS,
		`Probe for ${entry.runtimeId}`
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
	const cwd = body.cwd ?? process.cwd();
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

			results[index] = await getOrCreateProbePromise(entry, cwd, state).catch(
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
		cwd,
	});

	return {
		probedAt: Date.now(),
		agents: results,
	};
}
