/* global Bun */

import crypto from "node:crypto";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type { AcpEnvelope } from "@corporation/contracts/sandbox-do";
import { Effect, Layer, Queue, type Scope, ServiceMap, Stream } from "effect";
import { agentCommand, writeAgentConfigs } from "./agents";
import {
	AcpBridgeError,
	type RuntimeActionError as RuntimeActionErrorType,
	toAcpBridgeError,
	toRuntimeActionError,
} from "./errors";
import { ACP_REQUEST_TIMEOUT_MS } from "./helpers";
import { log } from "./logging";
import { buildLocalProxyEnv } from "./proxy-config";
import {
	type AcpAgentRequestMethod,
	type AcpAgentRequestParams,
	type AcpAgentRequestResult,
	getAcpAgentRequestMethodSchemas,
	sessionRequestPermissionEnvelopeSchema,
	sessionRequestPermissionResponseEnvelopeSchema,
} from "./schemas";

type EnvelopeDirection = "inbound" | "outbound";
type EnvelopeSink =
	| ((envelope: AcpEnvelope, direction: EnvelopeDirection) => void)
	| null;

type RequestOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
};

export type AcpBridge = {
	request: <M extends AcpAgentRequestMethod>(
		method: M,
		params: AcpAgentRequestParams<M>,
		options?: RequestOptions
	) => Effect.Effect<AcpAgentRequestResult<M>, AcpBridgeError>;
	write: (envelope: AcpEnvelope) => Effect.Effect<void, AcpBridgeError>;
	interrupt: Effect.Effect<void>;
	isAlive: Effect.Effect<boolean>;
	setEnvelopeSink: (sink: EnvelopeSink) => Effect.Effect<void>;
};

export type AcpBridgeFactoryShape = {
	make: (
		agent: string
	) => Effect.Effect<AcpBridge, RuntimeActionErrorType, Scope.Scope>;
};

export class AcpBridgeFactory extends ServiceMap.Service<
	AcpBridgeFactory,
	AcpBridgeFactoryShape
>()("sandbox-runtime/AcpBridgeFactory") {}

type PendingResolver = {
	resolve: (envelope: AcpEnvelope) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

function processLinesFromStream(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
	onClose?: () => void
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const drainBufferedLines = () => {
		let newlineIdx = buffer.indexOf("\n");
		while (newlineIdx !== -1) {
			onLine(buffer.slice(0, newlineIdx));
			buffer = buffer.slice(newlineIdx + 1);
			newlineIdx = buffer.indexOf("\n");
		}
	};

	return (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				drainBufferedLines();
			}
		} catch {
			// stream ended
		} finally {
			buffer += decoder.decode();
			drainBufferedLines();
			if (buffer.length > 0) {
				onLine(buffer);
				buffer = "";
			}
			onClose?.();
		}
	})();
}

function isUnsupportedMethodError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return msg.includes("(-32601)");
}

function pickPermissionOption(
	options: unknown[]
): { kind: string; optionId: string } | null {
	if (!Array.isArray(options)) {
		return null;
	}
	const allowAlways = options.find(
		(option) =>
			option &&
			typeof option === "object" &&
			(option as Record<string, unknown>).kind === "allow_always" &&
			typeof (option as Record<string, unknown>).optionId === "string"
	) as { kind: string; optionId: string } | undefined;
	if (allowAlways) {
		return allowAlways;
	}
	const allowOnce = options.find(
		(option) =>
			option &&
			typeof option === "object" &&
			(option as Record<string, unknown>).kind === "allow_once" &&
			typeof (option as Record<string, unknown>).optionId === "string"
	) as { kind: string; optionId: string } | undefined;
	return allowOnce ?? null;
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

function resolveResultEnvelope<M extends AcpAgentRequestMethod>(
	_method: M,
	methodSchemas: ReturnType<typeof getAcpAgentRequestMethodSchemas>,
	resultEnvelope: AcpEnvelope
): AcpAgentRequestResult<M> {
	if ("error" in resultEnvelope) {
		const error = resultEnvelope.error as {
			code?: unknown;
			message?: unknown;
		};
		throw new Error(
			`ACP error (${error.code}): ${error.message ?? JSON.stringify(error)}`
		);
	}

	if (!("result" in resultEnvelope)) {
		throw new Error(
			`ACP response missing result: ${JSON.stringify(resultEnvelope)}`
		);
	}

	const parsedResult = methodSchemas
		? methodSchemas.result.parse(resultEnvelope.result)
		: resultEnvelope.result;
	return parsedResult as AcpAgentRequestResult<M>;
}

function createBridge(
	agent: string
): Effect.Effect<AcpBridge, RuntimeActionErrorType, Scope.Scope> {
	return Effect.gen(function* () {
		const command = agentCommand(agent);
		log("info", "Spawning agent command (stdio)", { cmd: command.join(" ") });
		writeAgentConfigs(agent);

		const outboundQueue = yield* Queue.unbounded<AcpEnvelope>();
		const state = {
			dead: false,
			onEnvelopeSink: null as EnvelopeSink,
			pendingResolvers: new Map<string, PendingResolver>(),
			proc: Bun.spawn(command, {
				env: {
					...process.env,
					...buildLocalProxyEnv(),
					IS_SANDBOX: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			}),
		};

		const rejectPendingRequests = (error: Error): void => {
			for (const [id, pending] of state.pendingResolvers) {
				state.pendingResolvers.delete(id);
				clearTimeout(pending.timer);
				pending.reject(error);
			}
		};

		const emitEnvelope = (
			envelope: AcpEnvelope,
			direction: EnvelopeDirection
		): void => {
			state.onEnvelopeSink?.(envelope, direction);
		};

		const enqueueEnvelope = (envelope: AcpEnvelope): void => {
			emitEnvelope(envelope, "outbound");
			Queue.offerUnsafe(outboundQueue, envelope);
		};

		const maybeHandlePermissionRequest = (envelope: AcpEnvelope): void => {
			if (!("method" in envelope)) {
				return;
			}
			if (envelope.method !== CLIENT_METHODS.session_request_permission) {
				return;
			}

			const requestResult =
				sessionRequestPermissionEnvelopeSchema.safeParse(envelope);
			if (!requestResult.success) {
				return;
			}

			const selected = pickPermissionOption(requestResult.data.params.options);
			const response = sessionRequestPermissionResponseEnvelopeSchema.parse({
				jsonrpc: "2.0",
				id: requestResult.data.id,
				result: {
					outcome: selected
						? { outcome: "selected", optionId: selected.optionId }
						: { outcome: "cancelled" },
				},
			});
			enqueueEnvelope(response);
		};

		const routeStdoutEnvelope = (envelope: AcpEnvelope): void => {
			emitEnvelope(envelope, "inbound");
			const envelopeId =
				"id" in envelope && envelope.id != null ? String(envelope.id) : null;
			if (envelopeId) {
				const pending = state.pendingResolvers.get(envelopeId);
				if (pending) {
					state.pendingResolvers.delete(envelopeId);
					clearTimeout(pending.timer);
					pending.resolve(envelope);
					return;
				}
			}
			maybeHandlePermissionRequest(envelope);
		};

		const processStdoutLine = (rawLine: string): void => {
			const line = rawLine.trim();
			if (!line) {
				return;
			}

			try {
				routeStdoutEnvelope(JSON.parse(line) as AcpEnvelope);
			} catch (error) {
				log("warn", "Failed to parse agent stdout line", {
					line: line.slice(0, 200),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};

		const processStderrLine = (rawLine: string): void => {
			if (!rawLine.trim()) {
				return;
			}
			log("info", `[${agent} stderr] ${rawLine.trimEnd()}`);
		};

		if (state.proc.stdout) {
			yield* Effect.promise(() =>
				processLinesFromStream(state.proc.stdout, processStdoutLine, () => {
					state.dead = true;
					rejectPendingRequests(
						new Error(`Agent ${agent} stdout stream closed`)
					);
				})
			).pipe(Effect.forkScoped);
		}

		if (state.proc.stderr) {
			yield* Effect.promise(() =>
				processLinesFromStream(state.proc.stderr, processStderrLine)
			).pipe(Effect.forkScoped);
		}

		yield* Stream.fromQueue(outboundQueue).pipe(
			Stream.mapEffect((envelope) =>
				Effect.try({
					try: () => {
						if (state.dead || state.proc.exitCode !== null) {
							throw new Error(`Agent ${agent} is not writable`);
						}
						const stdin = state.proc.stdin;
						if (!stdin || typeof stdin !== "object") {
							throw new Error(`Agent ${agent} stdin is not available`);
						}
						stdin.write(`${JSON.stringify(envelope)}\n`);
					},
					catch: (cause) =>
						toAcpBridgeError(
							`Failed to write ACP envelope for ${agent}`,
							cause
						),
				})
			),
			Stream.runDrain,
			Effect.forkScoped
		);

		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				state.dead = true;
				rejectPendingRequests(new Error(`Agent bridge torn down: ${agent}`));
				yield* Queue.shutdown(outboundQueue);
				try {
					const stdin = state.proc.stdin;
					if (stdin && typeof stdin === "object") {
						stdin.end();
					}
				} catch {
					// stdin already closed
				}
				try {
					state.proc.kill();
				} catch {
					// process already gone
				}
			})
		);

		const bridge: AcpBridge = {
			request: (method, params, options) =>
				Effect.tryPromise({
					try: () => {
						if (state.dead || state.proc.exitCode !== null) {
							return Promise.reject(
								new Error(`Agent ${agent} is not running for ${method}`)
							);
						}

						const id = `${method}-${crypto.randomUUID()}`;
						const timeoutMs = options?.timeoutMs ?? ACP_REQUEST_TIMEOUT_MS;
						const methodSchemas = getAcpAgentRequestMethodSchemas(method);
						const parsedParams = methodSchemas
							? methodSchemas.params.parse(params)
							: params;
						const envelope = {
							jsonrpc: "2.0",
							id,
							method,
							params: parsedParams,
						} satisfies AcpEnvelope;

						return new Promise<AcpAgentRequestResult<typeof method>>(
							(resolve, reject) => {
								const onAbort = (signal: AbortSignal) => {
									const pending = state.pendingResolvers.get(id);
									if (!pending) {
										return;
									}
									state.pendingResolvers.delete(id);
									clearTimeout(pending.timer);
									reject(
										getAbortError(signal, `ACP request aborted: ${method}`)
									);
								};

								const timer = setTimeout(() => {
									const pending = state.pendingResolvers.get(id);
									if (!pending) {
										return;
									}
									state.pendingResolvers.delete(id);
									reject(new Error(`ACP request timed out: ${method} (${id})`));
								}, timeoutMs);

								if (options?.signal) {
									if (options.signal.aborted) {
										clearTimeout(timer);
										reject(
											getAbortError(
												options.signal,
												`ACP request aborted: ${method}`
											)
										);
										return;
									}
									options.signal.addEventListener(
										"abort",
										() => onAbort(options.signal as AbortSignal),
										{ once: true }
									);
								}

								state.pendingResolvers.set(id, {
									resolve: (resultEnvelope) => {
										try {
											resolve(
												resolveResultEnvelope(
													method,
													methodSchemas,
													resultEnvelope
												)
											);
										} catch (error) {
											reject(
												error instanceof Error
													? error
													: new Error(String(error))
											);
										}
									},
									reject,
									timer,
								});

								enqueueEnvelope(envelope);
							}
						);
					},
					catch: (cause) =>
						cause instanceof AcpBridgeError
							? cause
							: toAcpBridgeError(
									`ACP request failed for ${agent}: ${String(method)}`,
									cause
								),
				}),
			write: (envelope) =>
				Effect.try({
					try: () => {
						enqueueEnvelope(envelope);
					},
					catch: (cause) =>
						toAcpBridgeError(
							`Failed to queue ACP envelope for ${agent}`,
							cause
						),
				}),
			interrupt: Effect.sync(() => {
				state.dead = true;
				try {
					state.proc.kill();
				} catch {
					// process already gone
				}
			}),
			isAlive: Effect.sync(() => !state.dead && state.proc.exitCode === null),
			setEnvelopeSink: (sink) =>
				Effect.sync(() => {
					state.onEnvelopeSink = sink;
				}),
		};

		return bridge;
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.fail(
				toRuntimeActionError(`Failed to spawn bridge for ${agent}`, cause)
			)
		)
	);
}

export function setModelOrThrow(
	bridge: AcpBridge,
	agentSessionId: string,
	modelId: string
): Effect.Effect<void, AcpBridgeError> {
	return bridge
		.request(AGENT_METHODS.session_set_model, {
			sessionId: agentSessionId,
			modelId,
		})
		.pipe(
			Effect.catchIf(
				(_error): _error is AcpBridgeError => true,
				(error) => {
					if (isUnsupportedMethodError(error)) {
						log("warn", "session/set_model not supported by agent, skipping", {
							error: error instanceof Error ? error.message : String(error),
						});
						return Effect.succeed(undefined);
					}
					return Effect.fail(error as AcpBridgeError);
				}
			),
			Effect.asVoid
		);
}

export const AcpBridgeFactoryLive = Layer.succeed(AcpBridgeFactory)({
	make: createBridge,
});
