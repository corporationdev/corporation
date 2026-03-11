import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import type {
	AgentProbeAgent,
	AgentProbeRequestBody,
	AgentProbeResponse,
} from "@corporation/contracts/sandbox-do";
import { existsSync } from "node:fs";
import { Effect, Exit, Layer, Scope, ServiceMap } from "effect";
import {
	AcpBridgeFactory,
	type AcpBridgeFactoryShape,
	setModelOrThrow,
} from "./acp-bridge";
import { isAgentInstalled, runtimeAgentEntries } from "./agents";
import { ACP_PROTOCOL_VERSION } from "./helpers";
import { log } from "./logging";
import {
	type RuntimeActionError,
	toRuntimeActionError,
} from "./errors";
import { SessionRegistry } from "./session-registry";

const PROBE_CONCURRENCY = 9;
const ACP_ERROR_CODE_REGEX = /acp error \((-?\d+)\):/i;
const DEFAULT_PROBE_CWD = existsSync("/workspace") ? "/workspace" : process.cwd();

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
	return Effect.gen(function*() {
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
			const bridge = yield* bridgeFactory.make(entry.id).pipe(Scope.provide(scope));
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
						...base,
						status: "verified" as const,
						configOptions,
						verifiedAt: cached.verifiedAt,
						authCheckedAt,
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

			yield* registry.setVerifiedProbeEntry(entry.id, {
				verifiedAt: Date.now(),
			});

			return {
				...base,
				status: "verified" as const,
				configOptions,
				verifiedAt: Date.now(),
				authCheckedAt,
			};
		} catch (error) {
			yield* registry.setVerifiedProbeEntry(entry.id, null);

			if (isAuthRequiredError(error)) {
				return {
					...base,
					status: "requires_auth" as const,
					authCheckedAt,
					error: error instanceof Error ? error.message : String(error),
				};
			}

			return {
				...base,
				status: "error" as const,
				authCheckedAt,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			yield* Scope.close(scope, Exit.void);
		}
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.succeed({
				...buildProbeAgentBase({
					id: entry.id,
					name: entry.name,
				}),
				status: "error" as const,
				authCheckedAt: Date.now(),
				error: String(cause),
			})
		)
	);
}

export const ProbeServiceLive = Layer.effect(ProbeService)(
	Effect.gen(function*() {
		const registry = yield* SessionRegistry;
		const bridgeFactory = yield* AcpBridgeFactory;

		const getOrCreateProbePromise = (
			entry: RuntimeAgentEntry,
			probeCwd: string
		) =>
			Effect.gen(function*() {
				const existing = yield* registry.getInFlightProbe(entry.id);
				if (existing) {
					return existing;
				}

				const promise = Effect.runPromise(
					probeSingleAgent(entry, probeCwd, registry, bridgeFactory)
				).finally(() => {
					void Effect.runPromise(registry.setInFlightProbe(entry.id, null));
				});

				yield* registry.setInFlightProbe(entry.id, promise);
				return promise;
			});

		const service: ProbeServiceShape = {
			probeAgents: (body) =>
				Effect.gen(function*() {
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
