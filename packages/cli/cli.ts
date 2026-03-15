/* global WebSocket */

import process from "node:process";
import { Command } from "commander";
import { createSpawnedAcpConnectionFactory } from "./acp-connection";
import { createAcpDriver } from "./acp-driver";
import {
	getDefaultCredentialsPath,
	getDefaultRefreshToken,
	getDefaultServerUrl,
	loginWithBrowser,
	resolveRuntimeWebSocketUrl,
} from "./auth";
import { getDefaultRuntimeDatabasePath, openRuntimeDatabase } from "./db";
import { RuntimeEngine } from "./index";
import { RuntimeMessageStore } from "./runtime-message-store";
import { createWebSocketRuntimeTransport } from "./websocket-runtime-transport";

type LoginOptions = {
	serverUrl?: string;
	credentialsPath?: string;
};

type ConnectOptions = {
	dbPath?: string;
	url?: string;
	serverUrl?: string;
	token?: string;
	credentialsPath?: string;
};

const KNOWN_COMMANDS = new Set(["login", "connect"]);

function createSocket(url: string): WebSocket {
	return new WebSocket(url) as WebSocket;
}

function normalizeUserArgv(argv: string[]) {
	return KNOWN_COMMANDS.has(argv[0] ?? "") ? argv : ["connect", ...argv];
}

async function runLoginCommand(options: LoginOptions): Promise<void> {
	const serverUrl = options.serverUrl?.trim() || getDefaultServerUrl();

	await loginWithBrowser({
		credentialsPath:
			options.credentialsPath?.trim() || getDefaultCredentialsPath(),
		serverUrl,
	});
}

async function runConnectCommand(options: ConnectOptions): Promise<void> {
	const serverUrl = options.serverUrl?.trim() || getDefaultServerUrl();
	const websocketUrl = await resolveRuntimeWebSocketUrl({
		credentialsPath:
			options.credentialsPath?.trim() || getDefaultCredentialsPath(),
		refreshToken: options.token?.trim() || getDefaultRefreshToken(),
		serverUrl,
		url: options.url?.trim() || undefined,
	});
	const runtimeDatabase = await openRuntimeDatabase({
		path: options.dbPath?.trim() || getDefaultRuntimeDatabasePath(),
	});

	const factory = createSpawnedAcpConnectionFactory();
	const driver = createAcpDriver(factory);
	const engine = new RuntimeEngine(driver);
	const store = new RuntimeMessageStore(runtimeDatabase.db);

	const transport = createWebSocketRuntimeTransport({
		store,
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
	const program = new Command()
		.name("sandbox-runtime")
		.description("Tendril runtime CLI");

	program
		.command("login")
		.description("Authenticate this runtime with the Tendril server")
		.option("--server-url <url>", "Server base URL", getDefaultServerUrl())
		.option(
			"--credentials-path <path>",
			"Path to the stored runtime credentials",
			getDefaultCredentialsPath()
		)
		.action(async (options: LoginOptions) => {
			await runLoginCommand(options);
		});

	program
		.command("connect")
		.description("Connect this runtime to the Tendril server")
		.option(
			"--db-path <path>",
			"Path to the runtime SQLite database",
			getDefaultRuntimeDatabasePath()
		)
		.option("--url <url>", "Direct websocket URL")
		.option("--server-url <url>", "Server base URL", getDefaultServerUrl())
		.option(
			"--token <token>",
			"Refresh token to exchange for a runtime websocket URL",
			getDefaultRefreshToken()
		)
		.option(
			"--credentials-path <path>",
			"Path to the stored runtime credentials",
			getDefaultCredentialsPath()
		)
		.action(async (options: ConnectOptions) => {
			await runConnectCommand(options);
		});

	await program.parseAsync(normalizeUserArgv(process.argv.slice(2)), {
		from: "user",
	});
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
