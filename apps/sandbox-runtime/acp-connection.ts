/* global Bun */

import crypto from "node:crypto";
import type {
	AGENT_METHODS,
	CancelNotification,
} from "@agentclientprotocol/sdk";
import type { AcpEnvelope } from "@corporation/contracts/sandbox-do";
import type {
	AcpConnection,
	AcpConnectionFactory,
	AcpRequestMap,
	AcpRequestMethod,
} from "./acp-session-manager";
import { agentCommand, assertAgentCommandReady } from "./agents";

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

type PendingRequest<M extends AcpRequestMethod = AcpRequestMethod> = {
	method: M;
	resolve: (value: AcpRequestMap[M]["result"]) => void;
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

	const flushBufferedLines = () => {
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			onLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
			newlineIndex = buffer.indexOf("\n");
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
				flushBufferedLines();
			}
		} finally {
			buffer += decoder.decode();
			flushBufferedLines();
			if (buffer.length > 0) {
				onLine(buffer);
				buffer = "";
			}
			onClose?.();
		}
	})();
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function decodeResponse<M extends AcpRequestMethod>(
	method: M,
	envelope: AcpEnvelope
): AcpRequestMap[M]["result"] {
	if ("error" in envelope) {
		const error = envelope.error as { code?: unknown; message?: unknown };
		throw new Error(
			`ACP error (${String(error.code)}): ${String(error.message)} for ${method}`
		);
	}
	if (!("result" in envelope)) {
		throw new Error(`ACP response missing result for ${method}`);
	}
	return envelope.result as AcpRequestMap[M]["result"];
}

export function createSpawnedAcpConnectionFactory(): AcpConnectionFactory {
	return {
		connect(agent: string): Promise<AcpConnection> {
			assertAgentCommandReady(agent);

			const proc = Bun.spawn(agentCommand(agent), {
				env: {
					...process.env,
					IS_SANDBOX: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			const pendingRequests = new Map<string, PendingRequest>();
			let closed = false;

			const rejectAllPending = (error: Error) => {
				for (const [id, pending] of pendingRequests) {
					pendingRequests.delete(id);
					clearTimeout(pending.timer);
					pending.reject(error);
				}
			};

			const writeEnvelope = (envelope: AcpEnvelope): void => {
				if (closed || proc.exitCode !== null) {
					throw new Error(`ACP process for ${agent} is not writable`);
				}
				const stdin = proc.stdin;
				if (!stdin || typeof stdin !== "object") {
					throw new Error(`ACP stdin is not available for ${agent}`);
				}
				stdin.write(`${JSON.stringify(envelope)}\n`);
			};

			const handleEnvelope = (envelope: AcpEnvelope): void => {
				const responseId =
					"id" in envelope && envelope.id != null ? String(envelope.id) : null;
				if (responseId) {
					const pending = pendingRequests.get(responseId);
					if (pending) {
						pendingRequests.delete(responseId);
						clearTimeout(pending.timer);
						try {
							pending.resolve(
								decodeResponse(
									pending.method,
									envelope
								) as AcpRequestMap[typeof pending.method]["result"]
							);
						} catch (error) {
							pending.reject(toError(error));
						}
						return;
					}
				}
			};

			const handleStdoutLine = (rawLine: string): void => {
				const line = rawLine.trim();
				if (!line) {
					return;
				}
				try {
					handleEnvelope(JSON.parse(line) as AcpEnvelope);
				} catch {
					// Ignore non-ACP stdout lines from the wrapped agent process.
				}
			};

			const handleStreamClosed = () => {
				if (closed) {
					return;
				}
				closed = true;
				rejectAllPending(new Error(`ACP connection closed for ${agent}`));
			};

			if (proc.stdout) {
				processLinesFromStream(
					proc.stdout,
					handleStdoutLine,
					handleStreamClosed
				).catch(() => undefined);
			}
			if (proc.stderr) {
				processLinesFromStream(proc.stderr, () => undefined, undefined).catch(
					() => undefined
				);
			}
			proc.exited
				.then(() => {
					handleStreamClosed();
				})
				.catch(() => {
					handleStreamClosed();
				});

			return Promise.resolve({
				request<M extends AcpRequestMethod>(
					method: M,
					params: AcpRequestMap[M]["params"]
				): Promise<AcpRequestMap[M]["result"]> {
					if (closed || proc.exitCode !== null) {
						return Promise.reject(
							new Error(`ACP process for ${agent} is not running`)
						);
					}

					const id = `${method}-${crypto.randomUUID()}`;
					return new Promise<AcpRequestMap[M]["result"]>((resolve, reject) => {
						const timer = setTimeout(() => {
							const pending = pendingRequests.get(id);
							if (!pending) {
								return;
							}
							pendingRequests.delete(id);
							reject(
								new Error(`ACP request timed out: ${String(method)} (${id})`)
							);
						}, DEFAULT_REQUEST_TIMEOUT_MS);

						pendingRequests.set(id, {
							method,
							resolve,
							reject,
							timer,
						});

						try {
							writeEnvelope({
								jsonrpc: "2.0",
								id,
								method,
								params,
							} satisfies AcpEnvelope);
						} catch (error) {
							pendingRequests.delete(id);
							clearTimeout(timer);
							reject(toError(error));
						}
					});
				},

				notify(
					method: typeof AGENT_METHODS.session_cancel,
					params: CancelNotification
				): Promise<void> {
					writeEnvelope({
						jsonrpc: "2.0",
						method,
						params,
					} satisfies AcpEnvelope);
					return Promise.resolve();
				},

				close(): Promise<void> {
					if (closed) {
						return Promise.resolve();
					}
					closed = true;
					rejectAllPending(new Error(`ACP connection closed for ${agent}`));
					try {
						const stdin = proc.stdin;
						if (stdin && typeof stdin === "object") {
							stdin.end();
						}
					} catch {
						// ignored
					}
					try {
						proc.kill();
					} catch {
						// ignored
					}
					return Promise.resolve();
				},
			});
		},
	};
}
