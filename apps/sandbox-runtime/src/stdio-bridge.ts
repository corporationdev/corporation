/* global Bun */

import crypto from "node:crypto";
import {
	type AcpEnvelope,
	acpEnvelopeSchema,
} from "@corporation/contracts/sandbox-do";
import { agentCommand, agentEnv, writeAgentConfigs } from "./agents";
import { ACP_REQUEST_TIMEOUT_MS } from "./helpers";
import { log } from "./logging";
import {
	type AcpAgentRequestMethod,
	type AcpAgentRequestParams,
	type AcpAgentRequestResult,
	getAcpAgentRequestMethodSchemas,
} from "./schemas";

export type StdioBridge = {
	dead: boolean;
	onEnvelope:
		| ((envelope: AcpEnvelope, direction: "inbound" | "outbound") => void)
		| null;
	onNotification: ((envelope: AcpEnvelope) => void) | null;
	pendingResolvers: Map<
		string,
		{
			resolve: (envelope: AcpEnvelope) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>;
	proc: ReturnType<typeof Bun.spawn>;
};

function processLinesFromStream(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
	onClose?: () => void
): void {
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

	(async () => {
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

function rejectPendingRequests(bridge: StdioBridge, error: Error): void {
	for (const [id, pending] of bridge.pendingResolvers) {
		bridge.pendingResolvers.delete(id);
		clearTimeout(pending.timer);
		pending.reject(error);
	}
}

function routeStdoutEnvelope(bridge: StdioBridge, envelope: AcpEnvelope): void {
	bridge.onEnvelope?.(envelope, "inbound");

	const envId =
		"id" in envelope && envelope.id != null ? String(envelope.id) : null;
	if (envId && bridge.pendingResolvers.has(envId)) {
		const pending = bridge.pendingResolvers.get(envId);
		bridge.pendingResolvers.delete(envId);
		if (pending) {
			clearTimeout(pending.timer);
			pending.resolve(envelope);
		}
		return;
	}
	bridge.onNotification?.(envelope);
}

function processStdoutLine(bridge: StdioBridge, rawLine: string): void {
	const line = rawLine.trim();
	if (!line) {
		return;
	}

	try {
		const parsedJson = JSON.parse(line) as unknown;
		const envelopeResult = acpEnvelopeSchema.safeParse(parsedJson);
		if (!envelopeResult.success) {
			log("warn", "Discarding invalid ACP envelope from stdout", {
				line: line.slice(0, 200),
				error: envelopeResult.error.message,
			});
			return;
		}

		// The generic ACP SDK response schemas are lossy for method-specific
		// `result` payloads like `session/new`, so validate shape but preserve
		// the original parsed envelope for downstream method-specific parsing.
		routeStdoutEnvelope(bridge, parsedJson as AcpEnvelope);
	} catch {
		log("warn", "Failed to parse agent stdout line", {
			line: line.slice(0, 200),
		});
	}
}

function processStderrLine(agent: string, rawLine: string): void {
	if (!rawLine.trim()) {
		return;
	}
	log("info", `[${agent} stderr] ${rawLine.trimEnd()}`);
}

export function spawnStdioBridge(
	agent: string,
	onNotification: (envelope: AcpEnvelope) => void,
	onEnvelope:
		| ((envelope: AcpEnvelope, direction: "inbound" | "outbound") => void)
		| null = null
): StdioBridge {
	const cmd = agentCommand(agent);
	log("info", "Spawning agent command (stdio)", { cmd: cmd.join(" ") });

	// Write agent-specific config files before spawning
	writeAgentConfigs(agent);

	const proc = Bun.spawn(cmd, {
		env: { ...agentEnv(agent), IS_SANDBOX: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const bridge: StdioBridge = {
		proc,
		pendingResolvers: new Map(),
		onNotification,
		onEnvelope,
		dead: false,
	};

	if (proc.stdout) {
		processLinesFromStream(
			proc.stdout,
			(line) => processStdoutLine(bridge, line),
			() => {
				bridge.dead = true;
				rejectPendingRequests(
					bridge,
					new Error(`Agent ${agent} stdout stream closed`)
				);
			}
		);
	}

	if (proc.stderr) {
		processLinesFromStream(proc.stderr, (line) =>
			processStderrLine(agent, line)
		);
	}

	return bridge;
}

export function teardownBridge(
	bridge: StdioBridge,
	context: { agent: string; sessionId: string; reason: string }
): void {
	bridge.dead = true;
	rejectPendingRequests(
		bridge,
		new Error(`Agent bridge torn down: ${context.reason}`)
	);

	try {
		const stdin = bridge.proc.stdin;
		if (stdin && typeof stdin === "object") {
			stdin.end();
		}
	} catch {
		// stdin already closed
	}

	try {
		const stdout = bridge.proc.stdout;
		if (stdout && typeof stdout === "object") {
			stdout.cancel();
		}
	} catch {
		// stdout already closed
	}

	try {
		const stderr = bridge.proc.stderr;
		if (stderr && typeof stderr === "object") {
			stderr.cancel();
		}
	} catch {
		// stderr already closed
	}

	try {
		bridge.proc.kill();
	} catch {
		// process may already be gone
	}

	log("info", "Tore down spawned session bridge", context);
}

export function stdioWrite(bridge: StdioBridge, envelope: AcpEnvelope): void {
	bridge.onEnvelope?.(envelope, "outbound");
	const stdin = bridge.proc.stdin;
	if (stdin && typeof stdin === "object") {
		stdin.write(`${JSON.stringify(envelope)}\n`);
	}
}

export async function stdioRequest<M extends AcpAgentRequestMethod>(
	bridge: StdioBridge,
	method: M,
	params: AcpAgentRequestParams<M>,
	timeoutMs?: number
): Promise<AcpAgentRequestResult<M>>;
export async function stdioRequest<M extends string>(
	bridge: StdioBridge,
	method: M,
	params: M extends AcpAgentRequestMethod ? AcpAgentRequestParams<M> : unknown,
	timeoutMs: number = ACP_REQUEST_TIMEOUT_MS
): Promise<
	M extends AcpAgentRequestMethod ? AcpAgentRequestResult<M> : unknown
> {
	const id = `${method}-${crypto.randomUUID()}`;
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

	const responsePromise = new Promise<AcpEnvelope>((resolve, reject) => {
		const timer = setTimeout(() => {
			const pending = bridge.pendingResolvers.get(id);
			if (!pending) {
				return;
			}
			bridge.pendingResolvers.delete(id);
			reject(new Error(`ACP request timed out: ${method} (${id})`));
		}, timeoutMs);

		bridge.pendingResolvers.set(id, {
			resolve,
			reject,
			timer,
		});
	});

	stdioWrite(bridge, envelope);
	const result = await responsePromise;

	if ("error" in result) {
		const err = result.error as { code?: unknown; message?: unknown };
		throw new Error(
			`ACP error (${err.code}): ${err.message ?? JSON.stringify(err)}`
		);
	}

	if (!("result" in result)) {
		throw new Error(`ACP response missing result: ${JSON.stringify(result)}`);
	}

	const envelopeResult = result.result;
	const parsedResult = methodSchemas
		? methodSchemas.result.parse(envelopeResult)
		: envelopeResult;
	return parsedResult as M extends AcpAgentRequestMethod
		? AcpAgentRequestResult<M>
		: unknown;
}
