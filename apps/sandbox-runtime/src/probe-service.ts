import { existsSync } from "node:fs";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import type {
	AgentProbeAgent,
	AgentProbeRequestBody,
	AgentProbeResponse,
} from "@corporation/contracts/sandbox-do";
import { Cause, Effect, Exit, Layer, Scope, ServiceMap } from "effect";
import {
	AcpBridgeFactory,
	type AcpBridgeFactoryShape,
	setModelOrThrow,
} from "./acp-bridge";
import { isAgentInstalled, runtimeAgentEntries } from "./agents";
import {
	type AcpBridgeError,
	type RuntimeActionError,
	toRuntimeActionError,
} from "./errors";
import { ACP_PROTOCOL_VERSION } from "./helpers";
import { log } from "./logging";
import { SessionRegistry } from "./session-registry";

const PROBE_CONCURRENCY = 9;
const ACP_ERROR_CODE_REGEX = /acp error \((-?\d+)\):/i;
const DEFAULT_PROBE_CWD = existsSync("/workspace")
	? "/workspace"
	: process.cwd();

type RuntimeAgentEntry = ReturnType<typeof runtimeAgentEntries>[number];

export type ProbeServiceShape = {
	probeAgents: (
		body: AgentProbeRequestBody
	) => Effect.Effect<AgentProbeResponse, RuntimeActionError>;
};

export class ProbeService extends ServiceMap.Service<
	ProbeService,
	ProbeServiceShape
>()("sandbox-runtime/ProbeService") {}

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
	return code ? Number.parseInt(code, 10) : null;
}

export function isAuthRequiredError(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;

	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);

		if (getAcpErrorCode(current) === -32_000) {
			return true;
		}

		const message = (
			current instanceof Error ? current.message : String(current)
		)
			.toLowerCase()
			.trim();
		if (
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
		) {
			return true;
		}

		if (typeof current === "object" && "cause" in current) {
			current = (current as { cause?: unknown }).cause;
			continue;
		}

		break;
	}

	return false;
}

function buildVerifiedProbeAgent(
	base: AgentProbeAgent,
	configOptions: AgentProbeAgent["configOptions"],
	verifiedAt: number,
	authCheckedAt: number
): AgentProbeAgent {
	return {
		...base,
		status: "verified",
		configOptions,
		verifiedAt,
		authCheckedAt,
	};
}

function buildFailedProbeAgent(
	base: AgentProbeAgent,
	authCheckedAt: number,
	error: unknown
): AgentProbeAgent {
	return {
		...base,
		status: isAuthRequiredError(error) ? "requires_auth" : "error",
		authCheckedAt,
		error: error instanceof Error ? error.message : String(error),
	};
}

function extractProbeFailure(cause: unknown): unknown {
	if (!Cause.isCause(cause)) {
		return cause;
	}

	const failed = cause.reasons.find(Cause.isFailReason);
	if (failed) {
		return failed.error;
	}

	const defect = cause.reasons.find(Cause.isDieReason);
	if (defect) {
		return defect.defect;
	}

	return Cause.prettyErrors(cause)[0] ?? String(cause);
}

function verifyAgentSession(
	entry: RuntimeAgentEntry,
	cwd: string,
	registry: {
		getVerifiedProbeEntry: (
			agent: string
		) => Effect.Effect<{ verifiedAt: number } | null>;
		setVerifiedProbeEntry: (
			agent: string,
			entry: { verifiedAt: number } | null
		) => Effect.Effect<void>;
	},
	bridgeFactory: AcpBridgeFactoryShape,
	scope: Scope.Closeable
): Effect.Effect<
	{
		configOptions: AgentProbeAgent["configOptions"];
		verifiedAt: number;
	},
	AcpBridgeError | RuntimeActionError
> {
	return Effect.gen(function* () {
		const bridge = yield* bridgeFactory
			.make(entry.id)
			.pipe(Scope.provide(scope));
		yield* Effect.sleep(250);
		const alive = yield* bridge.isAlive;
		if (!alive) {
			throw new Error(`Agent ${entry.id} exited immediately during probe`);
		}

		yield* bridge.request("initialize", {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientInfo: { name: "sandbox-runtime", version: "v1" },
		});

		const sessionResult = yield* bridge.request("session/new", {
			cwd,
			mcpServers: [],
		});

		const configOptions = sessionResult.configOptions ?? [];
		const cached = yield* registry.getVerifiedProbeEntry(entry.id);
		if (cached) {
			return {
				configOptions,
				verifiedAt: cached.verifiedAt,
			};
		}

		if (sessionResult.models?.currentModelId) {
			yield* setModelOrThrow(
				bridge,
				sessionResult.sessionId,
				sessionResult.models.currentModelId
			);
		}

		yield* bridge.request(AGENT_METHODS.session_prompt, {
			sessionId: sessionResult.sessionId,
			prompt: [{ type: "text", text: "Reply with OK." }],
		});

		const verifiedAt = Date.now();
		yield* registry.setVerifiedProbeEntry(entry.id, {
			verifiedAt,
		});

		return {
			configOptions,
			verifiedAt,
		};
	});
}

function probeSingleAgent(
	entry: RuntimeAgentEntry,
	cwd: string,
	registry: {
		getVerifiedProbeEntry: (
			agent: string
		) => Effect.Effect<{ verifiedAt: number } | null>;
		setVerifiedProbeEntry: (
			agent: string,
			entry: { verifiedAt: number } | null
		) => Effect.Effect<void>;
	},
	bridgeFactory: AcpBridgeFactoryShape
): Effect.Effect<AgentProbeAgent> {
	return Effect.gen(function* () {
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

		const scope = yield* Scope.make();
		try {
			const result = yield* verifyAgentSession(
				entry,
				cwd,
				registry,
				bridgeFactory,
				scope
			);
			return buildVerifiedProbeAgent(
				base,
				result.configOptions,
				result.verifiedAt,
				authCheckedAt
			);
		} catch (error) {
			yield* registry.setVerifiedProbeEntry(entry.id, null);
			return buildFailedProbeAgent(base, authCheckedAt, error);
		} finally {
			yield* Scope.close(scope, Exit.void);
		}
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.succeed(
				buildFailedProbeAgent(
					buildProbeAgentBase({
						id: entry.id,
						name: entry.name,
					}),
					Date.now(),
					extractProbeFailure(cause)
				)
			)
		)
	);
}

export const ProbeServiceLive = Layer.effect(ProbeService)(
	Effect.gen(function* () {
		const registry = yield* SessionRegistry;
		const bridgeFactory = yield* AcpBridgeFactory;

		const getOrCreateProbePromise = (
			entry: RuntimeAgentEntry,
			probeCwd: string
		) =>
			Effect.gen(function* () {
				const existing = yield* registry.getInFlightProbe(entry.id);
				if (existing) {
					return existing;
				}

				const promise = Effect.runPromise(
					probeSingleAgent(entry, probeCwd, registry, bridgeFactory)
				).finally(() => {
					Effect.runPromise(registry.setInFlightProbe(entry.id, null)).catch(
						() => undefined
					);
				});

				yield* registry.setInFlightProbe(entry.id, promise);
				return promise;
			});

		const service: ProbeServiceShape = {
			probeAgents: (body) =>
				Effect.gen(function* () {
					const probeCwd = body.cwd ?? DEFAULT_PROBE_CWD;
					const entries = runtimeAgentEntries(body.ids);
					const promises = yield* Effect.all(
						entries.map((entry) => getOrCreateProbePromise(entry, probeCwd)),
						{ concurrency: PROBE_CONCURRENCY }
					);
					const agents = yield* Effect.tryPromise({
						try: () => Promise.all(promises),
						catch: (cause) =>
							toRuntimeActionError("Failed to collect probe results", cause),
					});

					log("info", "Completed agent probe batch", {
						count: agents.length,
						cwd: probeCwd,
					});

					return {
						probedAt: Date.now(),
						agents,
					};
				}),
		};

		return service;
	})
);
