/* global Bun */

import crypto from "node:crypto";
import { agentCommand, writeAgentConfigs } from "./agents";
import { ACP_REQUEST_TIMEOUT_MS } from "./helpers";
import { log } from "./logging";

export type StdioBridge = {
	dead: boolean;
	onEnvelope:
		| ((
				envelope: Record<string, unknown>,
				direction: "inbound" | "outbound"
		  ) => void)
		| null;
	onNotification: ((envelope: Record<string, unknown>) => void) | null;
	pendingResolvers: Map<
		string,
		{
			resolve: (envelope: Record<string, unknown>) => void;
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

function routeStdoutEnvelope(
	bridge: StdioBridge,
	envelope: Record<string, unknown>
): void {
	bridge.onEnvelope?.(envelope, "inbound");

	const envId = envelope.id != null ? String(envelope.id) : null;
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
		const envelope = JSON.parse(line) as Record<string, unknown>;
		routeStdoutEnvelope(bridge, envelope);
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
	onNotification: (envelope: Record<string, unknown>) => void,
	onEnvelope:
		| ((
				envelope: Record<string, unknown>,
				direction: "inbound" | "outbound"
		  ) => void)
		| null = null
): StdioBridge {
	const cmd = agentCommand(agent);
	log("info", "Spawning agent command (stdio)", { cmd: cmd.join(" ") });

	// Write agent-specific config files before spawning
	writeAgentConfigs(agent);

	const proc = Bun.spawn(cmd, {
		env: { ...process.env, IS_SANDBOX: "1" },
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

export function stdioWrite(
	bridge: StdioBridge,
	envelope: Record<string, unknown>
): void {
	bridge.onEnvelope?.(envelope, "outbound");
	const stdin = bridge.proc.stdin;
	if (stdin && typeof stdin === "object") {
		stdin.write(`${JSON.stringify(envelope)}\n`);
	}
}

export async function stdioRequest(
	bridge: StdioBridge,
	method: string,
	params: unknown,
	timeoutMs: number = ACP_REQUEST_TIMEOUT_MS
): Promise<Record<string, unknown>> {
	const id = `${method}-${crypto.randomUUID()}`;
	const envelope: Record<string, unknown> = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};

	const responsePromise = new Promise<Record<string, unknown>>(
		(resolve, reject) => {
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
		}
	);

	stdioWrite(bridge, envelope);
	const result = await responsePromise;

	if ("error" in result) {
		const err = result.error as Record<string, unknown>;
		throw new Error(
			`ACP error (${err.code}): ${err.message ?? JSON.stringify(err)}`
		);
	}

	return (result.result as Record<string, unknown>) ?? {};
}
