/* global WebSocket */

import { parseArgs } from "node:util";
import { createSpawnedAcpConnectionFactory } from "./acp-connection";
import { createAcpDriver } from "./acp-driver";
import {
	getDefaultCredentialsPath,
	getDefaultRefreshToken,
	getDefaultServerUrl,
	loginWithBrowser,
	resolveRuntimeWebSocketUrl,
} from "./auth";
import {
	getDefaultRuntimeDatabasePath,
	openRuntimeDatabase,
} from "./db";
import { RuntimeEngine } from "./index";
import { createWebSocketRuntimeTransport } from "./websocket-runtime-transport";

type Command = "connect" | "login";

function getCommandAndArgs(argv: string[]): {
	command: Command;
	args: string[];
} {
	const [maybeCommand, ...rest] = argv;
	if (maybeCommand === "login" || maybeCommand === "connect") {
		return { command: maybeCommand, args: rest };
	}
	return { command: "connect", args: argv };
}

function createSocket(url: string): WebSocket {
	return new WebSocket(url) as WebSocket;
}

async function runLoginCommand(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"server-url": { type: "string", default: getDefaultServerUrl() },
			"credentials-path": {
				type: "string",
				default: getDefaultCredentialsPath(),
			},
		},
		strict: true,
	});

	const serverUrl = values["server-url"]?.trim();
	if (!serverUrl) {
		throw new Error("--server-url is required for login");
	}

	await loginWithBrowser({
		credentialsPath: values["credentials-path"],
		serverUrl,
	});
}

async function runConnectCommand(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"db-path": {
				type: "string",
				default: getDefaultRuntimeDatabasePath(),
			},
			url: { type: "string" },
			"server-url": { type: "string", default: getDefaultServerUrl() },
			token: { type: "string", default: getDefaultRefreshToken() },
			"credentials-path": {
				type: "string",
				default: getDefaultCredentialsPath(),
			},
		},
		strict: true,
	});

	const websocketUrl = await resolveRuntimeWebSocketUrl({
		credentialsPath: values["credentials-path"],
		refreshToken: values.token?.trim() || undefined,
		serverUrl: values["server-url"]?.trim() || undefined,
		url: values.url?.trim() || undefined,
	});
	const runtimeDatabase = await openRuntimeDatabase({
		path: values["db-path"]?.trim() || undefined,
	});

	const factory = createSpawnedAcpConnectionFactory();
	const driver = createAcpDriver(factory);
	const engine = new RuntimeEngine(driver);

	const transport = createWebSocketRuntimeTransport({
		url: websocketUrl,
		runtime: engine,
		createSocket,
	});

	try {
		await transport.start();
	} catch (error) {
		runtimeDatabase.close();
		throw error;
	}
	console.log("Runtime connected");

	const shutdown = async () => {
		console.log("Shutting down...");
		await transport.close();
		runtimeDatabase.close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
	const { command, args } = getCommandAndArgs(process.argv.slice(2));
	if (command === "login") {
		await runLoginCommand(args);
		return;
	}
	await runConnectCommand(args);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
