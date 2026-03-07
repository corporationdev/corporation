import {
	ACP_PROTOCOL_VERSION,
	extractAuthMethods,
	pickPermissionOption,
	selectAuthMethod,
} from "./helpers";
import { log } from "./logging";
import { type StdioBridge, stdioRequest, stdioWrite } from "./stdio-bridge";

export type SessionBridge = {
	bridge: StdioBridge;
	agentSessionId: string;
	agent: string;
	cwd: string;
	modelId: string | undefined;
	activeTurnId: string | null;
	onEvent:
		| ((
				envelope: Record<string, unknown>,
				direction: "inbound" | "outbound"
		  ) => void)
		| null;
};

export const sessionBridges = new Map<string, SessionBridge>();
// Preserved agentSessionIds from dead bridges, keyed by corporation sessionId.
// Used to attempt session/load when the agent process restarts.
export const previousAgentSessionIds = new Map<string, string>();

async function performAuth(
	bridge: StdioBridge,
	agent: string,
	initResult: Record<string, unknown>
): Promise<void> {
	const authMethods = extractAuthMethods(initResult);
	if (authMethods.length === 0) {
		return;
	}
	const selectedAuth = selectAuthMethod(authMethods);
	if (selectedAuth) {
		await stdioRequest(bridge, "authenticate", {
			methodId: selectedAuth.methodId,
		});
		log("info", "ACP authentication succeeded", {
			agent,
			methodId: selectedAuth.methodId,
			envVar: selectedAuth.envVar,
		});
	} else {
		log("info", "ACP auth methods advertised but no env-backed match", {
			agent,
			authMethodIds: authMethods.map((method) => method.id),
		});
	}
}

export function maybeHandlePermissionRequest(
	bridge: StdioBridge,
	envelope: Record<string, unknown>
): void {
	if (envelope.method !== "requestPermission" || envelope.id == null) {
		return;
	}

	const reqParams = envelope.params as Record<string, unknown> | undefined;
	const request = reqParams?.request as Record<string, unknown> | undefined;
	const options = Array.isArray(request?.options) ? request.options : [];
	const selected = pickPermissionOption(options);

	const response: Record<string, unknown> = {
		jsonrpc: "2.0",
		id: envelope.id,
		result: {
			outcome: selected
				? { outcome: "selected", optionId: selected.optionId }
				: { outcome: "cancelled" },
		},
	};
	stdioWrite(bridge, response);
}

function isUnsupportedMethodError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return msg.includes("(-32601)");
}

export async function setModelOrThrow(
	bridge: StdioBridge,
	agentSessionId: string,
	modelId: string
): Promise<void> {
	try {
		await stdioRequest(bridge, "session/set_model", {
			sessionId: agentSessionId,
			modelId,
		});
	} catch (error) {
		if (isUnsupportedMethodError(error)) {
			log("warn", "session/set_model not supported by agent, skipping", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		throw error;
	}
}

export async function bootstrapSessionBridge(
	bridge: StdioBridge,
	sessionId: string,
	agent: string,
	cwd: string,
	modelId: string | undefined
): Promise<string> {
	await new Promise((r) => setTimeout(r, 250));
	if (bridge.proc.exitCode !== null) {
		throw new Error(
			`Agent ${agent} exited immediately with code ${bridge.proc.exitCode}`
		);
	}

	const initResult = await stdioRequest(bridge, "initialize", {
		protocolVersion: ACP_PROTOCOL_VERSION,
		clientInfo: { name: "sandbox-runtime", version: "v1" },
	});
	log("info", "ACP initialize result ", {
		sessionId,
		agent,
		initResult: JSON.stringify(initResult),
	});
	await performAuth(bridge, agent, initResult);

	const capabilities = initResult.agentCapabilities as
		| Record<string, unknown>
		| undefined;
	const supportsLoad = capabilities?.loadSession === true;
	const previousAgentSessionId = previousAgentSessionIds.get(sessionId);

	let agentSessionId: string | null = null;

	if (supportsLoad && previousAgentSessionId) {
		try {
			const loadResult = await stdioRequest(bridge, "session/load", {
				sessionId: previousAgentSessionId,
				cwd,
				mcpServers: [
					{
						name: "desktop",
						command: "bun",
						args: ["/usr/local/bin/sandbox-runtime.js", "mcp", "desktop"],
						env: [],
					},
				],
			});
			agentSessionId =
				(loadResult.sessionId as string) || previousAgentSessionId;
			log("info", "session/load succeeded", { sessionId, agentSessionId });
		} catch (error) {
			log("warn", "session/load failed, falling back to session/new", {
				sessionId,
				previousAgentSessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (!agentSessionId) {
		const mcpServers = [
			{
				name: "desktop",
				command: "bun",
				args: ["/usr/local/bin/sandbox-runtime.js", "mcp", "desktop"],
				env: [],
			},
		];
		log("info", "Sending session/new with mcpServers", {
			sessionId,
			cwd,
			mcpServers,
		});
		const sessionResult = await stdioRequest(bridge, "session/new", {
			cwd,
			mcpServers,
		});
		log("info", "session/new result", {
			sessionId,
			sessionResult: JSON.stringify(sessionResult),
		});
		agentSessionId = sessionResult.sessionId as string;
		if (!agentSessionId) {
			throw new Error("session/new did not return a sessionId");
		}
	}

	previousAgentSessionIds.delete(sessionId);

	// Set bypassPermissions mode so MCP servers are auto-approved in ACP mode
	try {
		await stdioRequest(bridge, "session/set_mode", {
			sessionId: agentSessionId,
			modeId: "bypassPermissions",
		});
		log("info", "Set bypassPermissions mode", { sessionId, agentSessionId });
	} catch (error) {
		log("warn", "Failed to set bypassPermissions mode", {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	if (modelId) {
		await setModelOrThrow(bridge, agentSessionId, modelId);
	}

	return agentSessionId;
}

export function getSessionBridge(sessionId: string): SessionBridge | null {
	const existing = sessionBridges.get(sessionId);
	if (!existing || existing.bridge.dead) {
		if (existing) {
			log("info", "Session bridge dead, discarding", {
				sessionId,
				exitCode: existing.bridge.proc.exitCode,
			});
			previousAgentSessionIds.set(sessionId, existing.agentSessionId);
			sessionBridges.delete(sessionId);
		}
		return null;
	}
	return existing;
}

export async function maybeSetModel(
	sessionBridge: SessionBridge,
	modelId: string | undefined
): Promise<void> {
	if (sessionBridge.modelId === modelId) {
		return;
	}
	if (modelId) {
		await setModelOrThrow(
			sessionBridge.bridge,
			sessionBridge.agentSessionId,
			modelId
		);
	}
	sessionBridge.modelId = modelId;
}
