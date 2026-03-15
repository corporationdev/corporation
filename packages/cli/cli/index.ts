import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { Command } from "commander";
import { getDefaultRuntimeDatabasePath } from "../agent-runtime/db";
import {
	clearRuntimeCredentials,
	exchangeRuntimeAccessToken,
	exchangeRuntimeApiKey,
	getDefaultApiKey,
	getDefaultAuthUrl,
	getDefaultCredentialsPath,
	getDefaultServerUrl,
	loadRuntimeCredentials,
	openBrowser,
	pollDeviceAuthorization,
	saveRuntimeCredentials,
	startDeviceAuthorization,
} from "./auth";
import { runDaemon } from "./daemon";
import { formatLogLine } from "./logging";
import {
	getDefaultRuntimeLogPath,
	getDefaultRuntimePidPath,
	getDefaultRuntimeStatePath,
	loadRuntimeState,
	saveRuntimeState,
	updateRuntimeState,
} from "./runtime-state";
import {
	getBackgroundServicePackagingNote,
	installAndStartBackgroundService,
	stopAndRemoveBackgroundService,
} from "./service-manager";

type SharedOptions = {
	credentialsPath?: string;
	serverUrl?: string;
	statePath?: string;
};

type LoginOptions = SharedOptions & {
	apiKey?: boolean | string;
	refreshToken?: string;
};

type ConnectOptions = SharedOptions & {
	apiKey?: boolean | string;
	dbPath?: string;
	logPath?: string;
	refreshToken?: string;
};

type DisconnectOptions = {
	statePath?: string;
};

type LogsOptions = {
	follow?: boolean;
	lines?: string;
	statePath?: string;
};

type LogoutOptions = SharedOptions;

type WhoAmIOptions = SharedOptions;
const LINE_SPLIT_RE = /\r?\n/u;

function sleep(ms: number) {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

function resolveApiKeyOption(input?: boolean | string): string | undefined {
	if (typeof input === "string") {
		const trimmed = input.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	if (input === true) {
		return getDefaultApiKey();
	}

	return undefined;
}

function addSharedAuthOptions(command: Command) {
	return command
		.option("--server-url <url>", "Server base URL", getDefaultServerUrl())
		.option(
			"--credentials-path <path>",
			"Path to stored Tendril CLI credentials",
			getDefaultCredentialsPath()
		)
		.option(
			"--state-path <path>",
			"Path to Tendril runtime state",
			getDefaultRuntimeStatePath()
		);
}

function getDaemonCommand(statePath: string): string[] {
	const entrypoint = process.argv[1]?.trim();
	if (!entrypoint) {
		throw new Error("Could not determine CLI entrypoint for daemon startup");
	}

	return [
		process.execPath,
		resolve(entrypoint),
		"daemon",
		"run",
		"--state-path",
		statePath,
	];
}

async function ensureRuntimeState(input: {
	connectionId: string;
	credentialsPath: string;
	dbPath: string;
	enabled: boolean;
	logPath: string;
	serverUrl: string;
	statePath: string;
}): Promise<string[]> {
	const existing = await loadRuntimeState({ path: input.statePath });
	const daemonCommand = getDaemonCommand(input.statePath);
	await saveRuntimeState({
		path: input.statePath,
		state: {
			version: 1,
			connectionId: input.connectionId,
			credentialsPath: input.credentialsPath,
			daemonCommand,
			daemonPid: existing?.daemonPid ?? null,
			dbPath: input.dbPath,
			enabled: input.enabled,
			lastConnectedAt: existing?.lastConnectedAt ?? null,
			lastDisconnectedAt: existing?.lastDisconnectedAt ?? null,
			lastError: existing?.lastError ?? null,
			lastStartedAt: existing?.lastStartedAt ?? null,
			logPath: input.logPath,
			pidPath: existing?.pidPath ?? getDefaultRuntimePidPath(),
			serverUrl: input.serverUrl,
		},
	});
	return daemonCommand;
}

async function resolveConnectionId(input: {
	credentialsPath: string;
	serverUrl: string;
	statePath: string;
}): Promise<string> {
	const [state, credentials] = await Promise.all([
		loadRuntimeState({ path: input.statePath }),
		loadRuntimeCredentials({
			credentialsPath: input.credentialsPath,
			serverUrl: input.serverUrl,
		}),
	]);

	return credentials?.clientId ?? state?.connectionId ?? crypto.randomUUID();
}

async function persistCredentialsIfNeeded(input: {
	connectionId: string;
	credentialsPath: string;
	refreshToken?: string;
	serverUrl: string;
}): Promise<void> {
	if (!input.refreshToken?.trim()) {
		return;
	}

	await saveRuntimeCredentials({
		clientId: input.connectionId,
		credentialsPath: input.credentialsPath,
		refreshToken: input.refreshToken.trim(),
		serverUrl: input.serverUrl,
	});
}

async function runLoginCommand(options: LoginOptions) {
	const serverUrl = options.serverUrl?.trim() || getDefaultServerUrl();
	const credentialsPath =
		options.credentialsPath?.trim() || getDefaultCredentialsPath();
	const statePath = options.statePath?.trim() || getDefaultRuntimeStatePath();
	const connectionId = await resolveConnectionId({
		credentialsPath,
		serverUrl,
		statePath,
	});

	if (options.refreshToken?.trim()) {
		await saveRuntimeCredentials({
			clientId: connectionId,
			credentialsPath,
			refreshToken: options.refreshToken.trim(),
			serverUrl,
		});
		await ensureRuntimeState({
			connectionId,
			credentialsPath,
			dbPath: getDefaultRuntimeDatabasePath(),
			enabled: false,
			logPath: getDefaultRuntimeLogPath(),
			serverUrl,
			statePath,
		});
		console.log(`Stored runtime credentials in ${credentialsPath}`);
		return;
	}

	const apiKey = resolveApiKeyOption(options.apiKey);
	if (options.apiKey !== undefined) {
		if (!apiKey) {
			throw new Error(
				"No API key provided. Pass --api-key <key> or set TENDRIL_API_KEY."
			);
		}

		const runtimeToken = await exchangeRuntimeApiKey({
			apiKey,
			clientId: connectionId,
			serverUrl,
		});
		await saveRuntimeCredentials({
			clientId: connectionId,
			credentialsPath,
			refreshToken: runtimeToken.refreshToken,
			serverUrl,
		});
		await ensureRuntimeState({
			connectionId,
			credentialsPath,
			dbPath: getDefaultRuntimeDatabasePath(),
			enabled: false,
			logPath: getDefaultRuntimeLogPath(),
			serverUrl,
			statePath,
		});
		console.log(`Stored runtime credentials in ${credentialsPath}`);
		return;
	}

	const authUrl = getDefaultAuthUrl(serverUrl);
	const started = await startDeviceAuthorization({
		authUrl,
		clientId: connectionId,
	});

	console.log("To sign in, open:\n");
	console.log(started.verification_uri);
	console.log("\nAnd enter code:\n");
	console.log(started.user_code);
	console.log("");

	try {
		openBrowser(started.verification_uri_complete);
		console.log("Opened browser for device login.\n");
	} catch {
		// Best effort only.
	}

	let intervalSeconds = started.interval;
	const expiresAt = Date.now() + started.expires_in * 1000;
	while (Date.now() < expiresAt) {
		await sleep(intervalSeconds * 1000);
		const pollResult = await pollDeviceAuthorization({
			authUrl,
			clientId: connectionId,
			deviceCode: started.device_code,
		});

		if (pollResult.status === "authorized") {
			const runtimeToken = await exchangeRuntimeAccessToken({
				accessToken: pollResult.accessToken,
				clientId: connectionId,
				serverUrl,
			});
			await saveRuntimeCredentials({
				clientId: connectionId,
				credentialsPath,
				refreshToken: runtimeToken.refreshToken,
				serverUrl,
			});
			await ensureRuntimeState({
				connectionId,
				credentialsPath,
				dbPath: getDefaultRuntimeDatabasePath(),
				enabled: false,
				logPath: getDefaultRuntimeLogPath(),
				serverUrl,
				statePath,
			});
			console.log(`Stored runtime credentials in ${credentialsPath}`);
			return;
		}

		if (pollResult.status === "authorization_pending") {
			continue;
		}

		if (pollResult.status === "slow_down") {
			intervalSeconds += 5;
			continue;
		}

		if (pollResult.status === "access_denied") {
			throw new Error("Device login was denied");
		}

		if (pollResult.status === "expired_token") {
			throw new Error("Device login expired before it was approved");
		}
	}

	throw new Error("Device login expired before it was approved");
}

async function runConnectCommand(options: ConnectOptions): Promise<void> {
	const serverUrl = options.serverUrl?.trim() || getDefaultServerUrl();
	const credentialsPath =
		options.credentialsPath?.trim() || getDefaultCredentialsPath();
	const statePath = options.statePath?.trim() || getDefaultRuntimeStatePath();
	const connectionId = await resolveConnectionId({
		credentialsPath,
		serverUrl,
		statePath,
	});

	await persistCredentialsIfNeeded({
		connectionId,
		credentialsPath,
		refreshToken: options.refreshToken,
		serverUrl,
	});

	let credentials = await loadRuntimeCredentials({
		credentialsPath,
		serverUrl,
	});
	const apiKey =
		resolveApiKeyOption(options.apiKey) ??
		(credentials ? undefined : getDefaultApiKey());
	if (apiKey) {
		const runtimeToken = await exchangeRuntimeApiKey({
			apiKey,
			clientId: connectionId,
			serverUrl,
		});
		await saveRuntimeCredentials({
			clientId: connectionId,
			credentialsPath,
			refreshToken: runtimeToken.refreshToken,
			serverUrl,
		});
		credentials = await loadRuntimeCredentials({
			credentialsPath,
			serverUrl,
		});
	}

	if (!credentials) {
		throw new Error("No runtime credentials found. Run `tendril login` first.");
	}

	const daemonCommand = await ensureRuntimeState({
		connectionId: credentials.clientId,
		credentialsPath,
		dbPath: options.dbPath?.trim() || getDefaultRuntimeDatabasePath(),
		enabled: true,
		logPath: options.logPath?.trim() || getDefaultRuntimeLogPath(),
		serverUrl,
		statePath,
	});

	await installAndStartBackgroundService({
		command: daemonCommand,
		logPath: options.logPath?.trim() || getDefaultRuntimeLogPath(),
	});

	console.log(`Tendril daemon enabled for connection ${credentials.clientId}`);
	console.log(`Logs: ${options.logPath?.trim() || getDefaultRuntimeLogPath()}`);
	const packagingNote = getBackgroundServicePackagingNote();
	if (packagingNote) {
		console.log("");
		console.log(packagingNote);
	}
}

async function runDisconnectCommand(options: DisconnectOptions): Promise<void> {
	const statePath = options.statePath?.trim() || getDefaultRuntimeStatePath();
	await updateRuntimeState({
		path: statePath,
		update: {
			daemonPid: null,
			enabled: false,
			lastDisconnectedAt: new Date().toISOString(),
		},
	});
	await stopAndRemoveBackgroundService();
	console.log("Tendril daemon disabled");
}

async function readLastLines(
	path: string,
	lineCount: number
): Promise<string[]> {
	try {
		const fileStat = await stat(path);
		if (fileStat.size <= 0) {
			return [];
		}

		const handle = await open(path, "r");
		try {
			let position = fileStat.size;
			let text = "";
			while (position > 0 && text.split("\n").length <= lineCount + 1) {
				const chunkSize = Math.min(position, 64 * 1024);
				position -= chunkSize;
				const buffer = Buffer.alloc(chunkSize);
				await handle.read(buffer, 0, chunkSize, position);
				text = buffer.toString("utf8") + text;
			}
			return text.split(LINE_SPLIT_RE).filter(Boolean).slice(-lineCount);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function readFromOffset(
	path: string,
	offset: number
): Promise<{
	nextOffset: number;
	text: string;
}> {
	try {
		const fileStat = await stat(path);
		const nextOffset = fileStat.size;
		if (nextOffset <= offset) {
			return { nextOffset, text: "" };
		}
		const handle = await open(path, "r");
		try {
			const length = nextOffset - offset;
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, offset);
			return {
				nextOffset,
				text: buffer.toString("utf8"),
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { nextOffset: 0, text: "" };
		}
		throw error;
	}
}

function printLogChunk(text: string): void {
	for (const line of text.split(LINE_SPLIT_RE)) {
		const formatted = formatLogLine(line);
		if (formatted) {
			process.stdout.write(`${formatted}\n`);
		}
	}
}

async function runLogsCommand(options: LogsOptions): Promise<void> {
	const statePath = options.statePath?.trim() || getDefaultRuntimeStatePath();
	const state = await loadRuntimeState({ path: statePath });
	const logPath = state?.logPath ?? getDefaultRuntimeLogPath();
	const lines = Number.parseInt(options.lines?.trim() ?? "100", 10);
	const follow = options.follow ?? true;

	for (const line of await readLastLines(
		logPath,
		Number.isFinite(lines) ? lines : 100
	)) {
		const formatted = formatLogLine(line);
		if (formatted) {
			process.stdout.write(`${formatted}\n`);
		}
	}

	if (!follow) {
		return;
	}

	let offset = await stat(logPath)
		.then((fileStat) => fileStat.size)
		.catch(() => 0);
	while (true) {
		const chunk = await readFromOffset(logPath, offset);
		offset = chunk.nextOffset;
		if (chunk.text) {
			printLogChunk(chunk.text);
		}
		await sleep(1000);
	}
}

async function runLogoutCommand(options: LogoutOptions): Promise<void> {
	const serverUrl = options.serverUrl?.trim() || getDefaultServerUrl();
	const credentialsPath =
		options.credentialsPath?.trim() || getDefaultCredentialsPath();
	await clearRuntimeCredentials({
		credentialsPath,
		serverUrl,
	});
	console.log(`Removed stored runtime credentials for ${serverUrl}`);
}

async function runWhoAmICommand(options: WhoAmIOptions): Promise<void> {
	const serverUrl = options.serverUrl?.trim() || getDefaultServerUrl();
	const credentialsPath =
		options.credentialsPath?.trim() || getDefaultCredentialsPath();
	const statePath = options.statePath?.trim() || getDefaultRuntimeStatePath();
	const [credentials, state] = await Promise.all([
		loadRuntimeCredentials({
			credentialsPath,
			serverUrl,
		}),
		loadRuntimeState({ path: statePath }),
	]);
	console.log(
		JSON.stringify(
			{
				connectionId: state?.connectionId ?? credentials?.clientId ?? null,
				credentialsPath,
				hasCredentials: Boolean(credentials),
				logPath: state?.logPath ?? null,
				serverUrl,
				statePath,
			},
			null,
			2
		)
	);
}

async function main(): Promise<void> {
	const program = new Command()
		.name("tendril")
		.description("Tendril CLI")
		.showHelpAfterError();

	addSharedAuthOptions(
		program
			.command("login")
			.description("Authenticate this CLI with Tendril")
			.option(
				"--api-key [key]",
				"Exchange an API key for a stored refresh token"
			)
			.option(
				"--refresh-token <token>",
				"Import a refresh token directly (advanced/internal)"
			)
	).action(async (options: LoginOptions) => {
		await runLoginCommand(options);
	});

	addSharedAuthOptions(
		program.command("logout").description("Remove stored Tendril credentials")
	).action(async (options: LogoutOptions) => {
		await runLogoutCommand(options);
	});

	addSharedAuthOptions(
		program
			.command("whoami")
			.description("Show the current Tendril authentication state")
	).action(async (options: WhoAmIOptions) => {
		await runWhoAmICommand(options);
	});

	addSharedAuthOptions(
		program
			.command("connect")
			.description("Enable the Tendril background runtime connection")
			.option(
				"--db-path <path>",
				"Path to the runtime SQLite database",
				getDefaultRuntimeDatabasePath()
			)
			.option(
				"--log-path <path>",
				"Path to the Tendril daemon log file",
				getDefaultRuntimeLogPath()
			)
			.option(
				"--refresh-token <token>",
				"Use a refresh token directly instead of stored credentials"
			)
			.option(
				"--api-key [key]",
				"Exchange an API key for a runtime session if no refresh token is available"
			)
	).action(async (options: ConnectOptions) => {
		await runConnectCommand(options);
	});

	program
		.command("disconnect")
		.description("Disable the Tendril background runtime connection")
		.option(
			"--state-path <path>",
			"Path to Tendril runtime state",
			getDefaultRuntimeStatePath()
		)
		.action(async (options: DisconnectOptions) => {
			await runDisconnectCommand(options);
		});

	program
		.command("logs")
		.description("Show recent Tendril daemon logs and follow new output")
		.option(
			"--state-path <path>",
			"Path to Tendril runtime state",
			getDefaultRuntimeStatePath()
		)
		.option("--lines <count>", "How many recent log lines to show", "100")
		.option("--no-follow", "Print recent logs only")
		.action(async (options: LogsOptions) => {
			await runLogsCommand(options);
		});

	program
		.command("daemon")
		.description("Internal daemon commands")
		.command("run")
		.option(
			"--state-path <path>",
			"Path to Tendril runtime state",
			getDefaultRuntimeStatePath()
		)
		.action(async (options: { statePath?: string }) => {
			await runDaemon(options);
		});

	await program.parseAsync(process.argv);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
