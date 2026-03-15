/* global WebSocket */

import { RuntimeEngine } from "../agent-runtime";
import { createSpawnedAcpConnectionFactory } from "../agent-runtime/acp-connection";
import { createAcpDriver } from "../agent-runtime/acp-driver";
import { openRuntimeDatabase } from "../agent-runtime/db";
import { RuntimeMessageStore } from "../agent-runtime/runtime-message-store";
import { createWebSocketRuntimeTransport } from "../agent-runtime/websocket-runtime-transport";
import { resolveRuntimeWebSocketUrl } from "./auth";
import { createDaemonLogger, installConsoleLogger } from "./logging";
import {
	acquirePidLock,
	loadRuntimeState,
	updateRuntimeState,
} from "./runtime-state";

function sleep(ms: number) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createSocket(url: string): WebSocket {
	return new WebSocket(url) as WebSocket;
}

export async function runDaemon(input?: { statePath?: string }): Promise<void> {
	const statePath = input?.statePath?.trim();
	const state = await loadRuntimeState({ path: statePath });
	if (!state?.enabled) {
		return;
	}

	const releasePidLock = await acquirePidLock({ path: state.pidPath });
	const logger = createDaemonLogger(state.logPath).child({
		connectionId: state.connectionId,
		serverUrl: state.serverUrl,
	});
	const restoreConsole = installConsoleLogger(logger);
	const runtimeDatabase = await openRuntimeDatabase({
		path: state.dbPath,
	});
	const store = new RuntimeMessageStore(runtimeDatabase.db);
	const driver = createAcpDriver(createSpawnedAcpConnectionFactory());
	const runtime = new RuntimeEngine(driver);
	const transport = createWebSocketRuntimeTransport({
		createSocket,
		onConnected: async () => {
			await updateRuntimeState({
				path: statePath,
				update: {
					daemonPid: process.pid,
					lastConnectedAt: new Date().toISOString(),
					lastError: null,
				},
			});
			logger.info("runtime connected");
		},
		onDisconnected: async (event) => {
			await updateRuntimeState({
				path: statePath,
				update: {
					lastDisconnectedAt: new Date().toISOString(),
					lastError: event.reason,
				},
			});
			logger.warn({ reason: event.reason }, "runtime disconnected");
		},
		resolveUrl: async () => {
			const currentState = await loadRuntimeState({ path: statePath });
			if (!currentState?.enabled) {
				throw new Error("Runtime daemon disabled");
			}
			return await resolveRuntimeWebSocketUrl({
				credentialsPath: currentState.credentialsPath,
				serverUrl: currentState.serverUrl,
			});
		},
		runtime,
		store,
	});

	let stopping = false;
	const shutdown = async () => {
		if (stopping) {
			return;
		}
		stopping = true;
		logger.info("daemon shutting down");
		await transport.close().catch(() => undefined);
		runtimeDatabase.close();
		await updateRuntimeState({
			path: statePath,
			update: {
				daemonPid: null,
				lastDisconnectedAt: new Date().toISOString(),
			},
		}).catch(() => undefined);
		await releasePidLock().catch(() => undefined);
		restoreConsole();
		process.exit(0);
	};

	process.on("SIGINT", () => {
		shutdown().catch(() => undefined);
	});
	process.on("SIGTERM", () => {
		shutdown().catch(() => undefined);
	});

	await updateRuntimeState({
		path: statePath,
		update: {
			daemonPid: process.pid,
			lastError: null,
			lastStartedAt: new Date().toISOString(),
		},
	});
	logger.info("daemon started");

	while (!stopping) {
		try {
			await transport.start();
			break;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await updateRuntimeState({
				path: statePath,
				update: {
					lastError: message,
				},
			});
			logger.error({ error: message }, "runtime start failed");
			await sleep(5000);
		}
	}

	await new Promise<void>(() => undefined);
}
