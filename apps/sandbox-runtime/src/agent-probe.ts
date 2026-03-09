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

const PROBE_TIMEOUT_MS = 8000;
const PROBE_CONCURRENCY = 2;

type ProbeModelsResult = {
	models: AgentProbeAgent["models"];
	defaultModelId: string | null;
};

function buildDesktopMcpServers() {
	return [
		{
			name: "desktop",
			command: "bun",
			args: ["/usr/local/bin/sandbox-runtime.js", "mcp", "desktop"],
			env: [],
		},
	];
}

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

function isAuthRequiredError(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error))
		.toLowerCase()
		.trim();
	return (
		message.includes("auth_required") ||
		message.includes("authentication required") ||
		message.includes("requires authentication") ||
		message.includes("requires auth") ||
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

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;

	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

async function probeSingleAgent(
	entry: ReturnType<typeof runtimeAgentEntries>[number],
	cwd: string
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

	try {
		await new Promise((resolve) => setTimeout(resolve, 250));
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
			PROBE_TIMEOUT_MS
		);

		const sessionResult = await stdioRequest<"session/new">(
			bridge,
			"session/new",
			{
				cwd,
				mcpServers: buildDesktopMcpServers(),
			},
			PROBE_TIMEOUT_MS
		);
		const normalizedModels = normalizeProbeModels(sessionResult);

		return {
			...base,
			status: "ready",
			models: normalizedModels.models,
			defaultModelId: normalizedModels.defaultModelId,
		};
	} catch (error) {
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
		teardownBridge(bridge, {
			agent: entry.runtimeId,
			sessionId,
			reason: "agent probe completed",
		});
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
				probeSingleAgent(entry, cwd),
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
