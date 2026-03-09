import crypto from "node:crypto";
import type { AGENT_METHODS } from "@agentclientprotocol/sdk";
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

function isAuthRequiredError(error: unknown): boolean {
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
	return normalizeConfigOptionModels(sessionResult.configOptions);
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

async function probeSingleAgent(
	entry: ReturnType<typeof runtimeAgentEntries>[number],
	cwd: string,
	signal?: AbortSignal
): Promise<AgentProbeAgent> {
	const base = buildProbeAgentBase({
		id: entry.id,
		name: entry.name,
	});
	if (!isAgentInstalled(entry.runtimeId)) {
		return base;
	}

	const bridge = spawnStdioBridge(entry.runtimeId, () => undefined);
	const sessionId = `probe-${entry.runtimeId}-${crypto.randomUUID()}`;
	let bridgeTornDown = false;
	const closeBridge = (reason: string) => {
		if (bridgeTornDown) {
			return;
		}
		bridgeTornDown = true;
		teardownBridge(bridge, {
			agent: entry.runtimeId,
			sessionId,
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

		return {
			...base,
			status: "ready",
			models: normalizedModels.models,
			defaultModelId: normalizedModels.defaultModelId,
		};
	} catch (error) {
		if (signal?.aborted) {
			throw getAbortError(signal, `Probe for ${entry.runtimeId} aborted`);
		}

		if (isAuthRequiredError(error)) {
			return {
				...base,
				status: "requires_auth",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		return {
			...base,
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		signal?.removeEventListener("abort", onAbort);
		closeBridge("agent probe completed");
	}
}

export async function probeAgents(
	body: AgentProbeRequestBody
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
			results[index] = await withTimeout(
				(signal) => probeSingleAgent(entry, cwd, signal),
				PROBE_TIMEOUT_MS,
				`Probe for ${entry.runtimeId}`
			).catch((error) => ({
				...buildProbeAgentBase({
					id: entry.id,
					name: entry.name,
				}),
				status: "error" as const,
				error: error instanceof Error ? error.message : String(error),
			}));
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
