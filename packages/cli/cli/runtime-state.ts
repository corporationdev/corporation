import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_RUNTIME_HOME = join(homedir(), ".tendril");
const DEFAULT_RUNTIME_STATE_PATH = join(
	DEFAULT_RUNTIME_HOME,
	"runtime-state.json"
);
const DEFAULT_RUNTIME_LOG_PATH = join(
	DEFAULT_RUNTIME_HOME,
	"logs",
	"daemon.log"
);
const DEFAULT_RUNTIME_PID_PATH = join(
	DEFAULT_RUNTIME_HOME,
	"run",
	"daemon.pid"
);
const DEFAULT_POSIX_WRAPPER_PATH = join(
	DEFAULT_RUNTIME_HOME,
	"run",
	"daemon.sh"
);
const DEFAULT_WINDOWS_WRAPPER_PATH = join(
	DEFAULT_RUNTIME_HOME,
	"run",
	"daemon.cmd"
);

export type RuntimeState = {
	connectionId: string;
	credentialsPath: string;
	daemonCommand: string[];
	daemonPid: number | null;
	dbPath: string;
	enabled: boolean;
	lastConnectedAt: string | null;
	lastDisconnectedAt: string | null;
	lastError: string | null;
	lastStartedAt: string | null;
	logPath: string;
	pidPath: string;
	serverUrl: string;
	updatedAt: string;
	version: 1;
};

function withTimestamp(state: Omit<RuntimeState, "updatedAt">): RuntimeState {
	return {
		...state,
		updatedAt: new Date().toISOString(),
	};
}

export function getDefaultRuntimeStatePath(): string {
	return (
		process.env.TENDRIL_RUNTIME_STATE_PATH?.trim() || DEFAULT_RUNTIME_STATE_PATH
	);
}

export function getDefaultRuntimeLogPath(): string {
	return (
		process.env.TENDRIL_RUNTIME_LOG_PATH?.trim() || DEFAULT_RUNTIME_LOG_PATH
	);
}

export function getDefaultRuntimePidPath(): string {
	return (
		process.env.TENDRIL_RUNTIME_PID_PATH?.trim() || DEFAULT_RUNTIME_PID_PATH
	);
}

export function getDefaultPosixWrapperPath(): string {
	return DEFAULT_POSIX_WRAPPER_PATH;
}

export function getDefaultWindowsWrapperPath(): string {
	return DEFAULT_WINDOWS_WRAPPER_PATH;
}

export async function loadRuntimeState(input?: {
	path?: string;
}): Promise<RuntimeState | null> {
	const path = input?.path?.trim() || getDefaultRuntimeStatePath();
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<RuntimeState>;
		if (
			parsed.version !== 1 ||
			typeof parsed.connectionId !== "string" ||
			typeof parsed.credentialsPath !== "string" ||
			!Array.isArray(parsed.daemonCommand) ||
			typeof parsed.dbPath !== "string" ||
			typeof parsed.enabled !== "boolean" ||
			typeof parsed.logPath !== "string" ||
			typeof parsed.pidPath !== "string" ||
			typeof parsed.serverUrl !== "string" ||
			typeof parsed.updatedAt !== "string"
		) {
			throw new Error(`Runtime state at ${path} is invalid`);
		}
		return {
			version: 1,
			connectionId: parsed.connectionId,
			credentialsPath: parsed.credentialsPath,
			daemonCommand: parsed.daemonCommand.map(String),
			daemonPid: typeof parsed.daemonPid === "number" ? parsed.daemonPid : null,
			dbPath: parsed.dbPath,
			enabled: parsed.enabled,
			lastConnectedAt:
				typeof parsed.lastConnectedAt === "string"
					? parsed.lastConnectedAt
					: null,
			lastDisconnectedAt:
				typeof parsed.lastDisconnectedAt === "string"
					? parsed.lastDisconnectedAt
					: null,
			lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
			lastStartedAt:
				typeof parsed.lastStartedAt === "string" ? parsed.lastStartedAt : null,
			logPath: parsed.logPath,
			pidPath: parsed.pidPath,
			serverUrl: parsed.serverUrl,
			updatedAt: parsed.updatedAt,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export async function saveRuntimeState(input: {
	path?: string;
	state: Omit<RuntimeState, "updatedAt"> | RuntimeState;
}): Promise<RuntimeState> {
	const path = input.path?.trim() || getDefaultRuntimeStatePath();
	const nextState = withTimestamp({
		...input.state,
		version: 1,
	});
	await writeJsonFile(path, nextState);
	return nextState;
}

export async function updateRuntimeState(input: {
	path?: string;
	update: Partial<Omit<RuntimeState, "updatedAt" | "version">>;
}): Promise<RuntimeState | null> {
	const path = input.path?.trim() || getDefaultRuntimeStatePath();
	const existing = await loadRuntimeState({ path });
	if (!existing) {
		return null;
	}
	return await saveRuntimeState({
		path,
		state: {
			...existing,
			...input.update,
		},
	});
}

export async function writeJsonFile(
	path: string,
	value: unknown
): Promise<void> {
	await writeFileWithParents(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeFileWithParents(
	path: string,
	content: string
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

export async function acquirePidLock(input?: {
	path?: string;
}): Promise<() => Promise<void>> {
	const path = input?.path?.trim() || getDefaultRuntimePidPath();
	await mkdir(dirname(path), { recursive: true });
	try {
		const handle = await open(path, "wx");
		await handle.writeFile(`${process.pid}\n`);
		await handle.close();
		return async () => {
			await rm(path, { force: true });
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}

		const raw = await readFile(path, "utf8").catch(() => "");
		const pid = Number.parseInt(raw.trim(), 10);
		if (Number.isFinite(pid)) {
			try {
				process.kill(pid, 0);
				throw new Error(`Tendril daemon is already running with pid ${pid}`);
			} catch (signalError) {
				if ((signalError as NodeJS.ErrnoException).code !== "ESRCH") {
					throw signalError;
				}
			}
		}

		await rm(path, { force: true });
		return await acquirePidLock({ path });
	}
}
