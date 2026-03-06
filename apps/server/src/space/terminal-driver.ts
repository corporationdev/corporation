import { createLogger } from "@corporation/logger";
import { eq } from "drizzle-orm";
import { CommandExitError, type CommandHandle, type Sandbox } from "e2b";
import { tabs, terminals } from "../db/schema";
import { createTabChannel, createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import {
	publishToChannel,
	subscribeToChannel,
	unsubscribeFromChannel,
} from "./subscriptions";
import type { SpaceRuntimeContext } from "./types";

const log = createLogger("space:terminal");
const TERMINAL_OUTPUT_EVENT_NAME = "terminal.output";
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 30;
const PTY_TIMEOUT_MS = 0;
const TMUX_HISTORY_LIMIT = 2000;
const SNAPSHOT_DEBOUNCE_MS = 1000;
const DEV_SERVER_TERMINAL_ID = "devserver";
const ENCODER = new TextEncoder();

type TerminalOutputPayload = {
	terminalId: string;
	data: number[];
	snapshot?: boolean;
};

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function runRootCommand(sandbox: Sandbox, command: string) {
	return sandbox.commands.run(command, { user: "root" });
}

function connectionTerminalKey(connId: string, terminalId: string): string {
	return `${connId}:${terminalId}`;
}

function toBytes(value: string): number[] {
	return Array.from(ENCODER.encode(value));
}

function normalizeTerminalDimension(
	value: number | undefined,
	fallback: number
): number {
	if (!(typeof value === "number" && Number.isFinite(value))) {
		return fallback;
	}
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : fallback;
}

function isProcessNotFoundError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return (
		error.name === "NotFoundError" &&
		error.message.includes("process with pid") &&
		error.message.includes("not found")
	);
}

async function directoryExists(
	sandbox: Sandbox,
	path: string
): Promise<boolean> {
	try {
		await runRootCommand(sandbox, `test -d ${quoteShellArg(path)}`);
		return true;
	} catch (error) {
		if (error instanceof CommandExitError) {
			return false;
		}
		throw error;
	}
}

async function configureTmuxSession(
	sandbox: Sandbox,
	sessionName: string
): Promise<void> {
	const safeSessionName = quoteShellArg(sessionName);
	await runRootCommand(
		sandbox,
		`tmux set-option -t ${safeSessionName} history-limit ${TMUX_HISTORY_LIMIT} \\; set-option -t ${safeSessionName} mouse on \\; set-option -t ${safeSessionName} status off`
	);
}

async function sendTerminalSnapshotToConnection(
	ctx: SpaceRuntimeContext,
	terminalId: string
): Promise<void> {
	if (!ctx.conn) {
		return;
	}
	const connection = ctx.conns.get(ctx.conn.id);
	if (!connection) {
		return;
	}

	try {
		const sandbox = ctx.vars.sandbox;
		const result = await runRootCommand(
			sandbox,
			`tmux capture-pane -p -e -t ${quoteShellArg(terminalId)} -S -`
		);
		if (!result.stdout) {
			return;
		}
		const snapshot = result.stdout.endsWith("\n")
			? result.stdout
			: `${result.stdout}\n`;
		const payload: TerminalOutputPayload = {
			terminalId,
			snapshot: true,
			data: toBytes(snapshot),
		};
		connection.send(TERMINAL_OUTPUT_EVENT_NAME, payload);
	} catch (error) {
		if (error instanceof CommandExitError) {
			return;
		}
		throw error;
	}
}

async function hasTmuxSession(
	sandbox: Sandbox,
	sessionName: string
): Promise<boolean> {
	try {
		await runRootCommand(
			sandbox,
			`tmux has-session -t ${quoteShellArg(sessionName)}`
		);
		return true;
	} catch (error) {
		if (error instanceof CommandExitError) {
			return false;
		}
		throw error;
	}
}

async function ensureTmuxSession(
	sandbox: Sandbox,
	sessionName: string,
	cwd?: string
): Promise<void> {
	const safeSessionName = quoteShellArg(sessionName);
	if (await hasTmuxSession(sandbox, sessionName)) {
		await configureTmuxSession(sandbox, sessionName);
		return;
	}

	let cwdFlag = "";
	if (cwd) {
		if (await directoryExists(sandbox, cwd)) {
			cwdFlag = ` -c ${quoteShellArg(cwd)}`;
		} else {
			log.warn(
				{ sessionName, cwd },
				"tmux cwd does not exist, creating session without cwd override"
			);
		}
	}

	try {
		await runRootCommand(
			sandbox,
			`tmux new-session -d -s ${safeSessionName}${cwdFlag}`
		);
	} catch (error) {
		if (!(error instanceof CommandExitError)) {
			throw error;
		}
		if (!(await hasTmuxSession(sandbox, sessionName))) {
			throw error;
		}
	}

	await configureTmuxSession(sandbox, sessionName);
}

async function createTmuxPty(
	sandbox: Sandbox,
	sessionName: string,
	cols: number,
	rows: number,
	onData: (data: Uint8Array) => void
): Promise<{ handle: CommandHandle; pid: number }> {
	const handle = await sandbox.pty.create({
		cols,
		rows,
		onData,
		timeoutMs: PTY_TIMEOUT_MS,
		user: "root",
	});

	const attachCmd = `exec tmux attach-session -t ${quoteShellArg(sessionName)}\n`;
	await sandbox.pty.sendInput(handle.pid, ENCODER.encode(attachCmd));

	return { handle, pid: handle.pid };
}

async function connectOrCreatePty(
	sandbox: Sandbox,
	sessionName: string,
	existingPid: number | null,
	cols: number,
	rows: number,
	onData: (data: Uint8Array) => void,
	cwd?: string
): Promise<{ handle: CommandHandle; pid: number }> {
	// Kill stale PTY if it exists — we always create a fresh one
	// to avoid duplicate tmux attach sessions.
	if (existingPid !== null) {
		try {
			await sandbox.pty.kill(existingPid);
		} catch {
			// Best-effort: process may already be gone
		}
	}

	await ensureTmuxSession(sandbox, sessionName, cwd);
	return createTmuxPty(sandbox, sessionName, cols, rows, onData);
}

function getTerminalHandleOrThrow(
	ctx: SpaceRuntimeContext,
	terminalId: string
): CommandHandle {
	const handle = ctx.vars.terminalHandles.get(terminalId);
	if (!handle) {
		throw new Error("Terminal handle is not available after ensureTerminal");
	}
	return handle;
}

async function recreateTerminalHandle(
	ctx: SpaceRuntimeContext,
	terminalId: string,
	cols?: number,
	rows?: number
): Promise<CommandHandle> {
	const previousHandle = ctx.vars.terminalHandles.get(terminalId);
	if (previousHandle) {
		try {
			await previousHandle.disconnect();
		} catch (error) {
			log.warn(
				{ terminalId, err: error },
				"failed to disconnect stale terminal handle"
			);
		}
	}
	ctx.vars.terminalHandles.delete(terminalId);

	await ensureTerminal(ctx, terminalId, cols, rows);

	const refreshedHandle = ctx.vars.terminalHandles.get(terminalId);
	if (!refreshedHandle) {
		throw new Error("Terminal handle is not available after recreation");
	}

	return refreshedHandle;
}

function trackTerminalExit(
	ctx: SpaceRuntimeContext,
	terminalId: string,
	handle: CommandHandle,
	pid: number
): void {
	handle
		.wait()
		.catch((error) => {
			log.info(
				{ terminalId, pid, err: error },
				"terminal pty process exited with error"
			);
		})
		.then(async () => {
			if (ctx.vars.terminalHandles.get(terminalId) !== handle) {
				return;
			}

			ctx.vars.terminalHandles.delete(terminalId);
			await ctx.vars.db
				.update(terminals)
				.set({ ptyPid: null, updatedAt: Date.now() })
				.where(eq(terminals.id, terminalId));

			log.info({ terminalId, pid }, "terminal pty process exited");
		})
		.catch((error) => {
			log.warn(
				{ terminalId, pid, err: error },
				"failed to process terminal pty exit"
			);
		});
}

async function ensureTerminal(
	ctx: SpaceRuntimeContext,
	terminalId: string,
	cols?: number,
	rows?: number
): Promise<void> {
	const previousEnsure = ctx.vars.terminalEnsures.get(terminalId);
	const runEnsure = async () => {
		await ensureTerminalOnce(ctx, terminalId, cols, rows);
	};
	const nextEnsure = previousEnsure
		? previousEnsure.then(runEnsure, runEnsure)
		: runEnsure();

	ctx.vars.terminalEnsures.set(terminalId, nextEnsure);
	try {
		await nextEnsure;
	} finally {
		if (ctx.vars.terminalEnsures.get(terminalId) === nextEnsure) {
			ctx.vars.terminalEnsures.delete(terminalId);
		}
	}
}

async function ensureTerminalOnce(
	ctx: SpaceRuntimeContext,
	terminalId: string,
	cols?: number,
	rows?: number
): Promise<void> {
	const now = Date.now();
	const tabId = createTabId("terminal", terminalId);
	const nextCols = normalizeTerminalDimension(cols, DEFAULT_TERMINAL_COLS);
	const nextRows = normalizeTerminalDimension(rows, DEFAULT_TERMINAL_ROWS);

	await ctx.vars.db.transaction(async (tx) => {
		const existing = await tx
			.select({
				id: terminals.id,
				cols: terminals.cols,
				rows: terminals.rows,
			})
			.from(terminals)
			.where(eq(terminals.id, terminalId))
			.limit(1);

		if (existing.length === 0) {
			const title =
				terminalId === DEV_SERVER_TERMINAL_ID ? "Dev Server" : "Terminal";
			await tx.insert(tabs).values({
				id: tabId,
				type: "terminal",
				title,
				active: true,
				createdAt: now,
				updatedAt: now,
				archivedAt: null,
			});

			await tx.insert(terminals).values({
				id: terminalId,
				tabId,
				ptyPid: null,
				cols: nextCols,
				rows: nextRows,
				createdAt: now,
				updatedAt: now,
			});
			return;
		}

		const existingTerminal = existing[0];
		if (!existingTerminal) {
			return;
		}
		if (cols !== undefined || rows !== undefined) {
			const updatedCols =
				cols !== undefined
					? normalizeTerminalDimension(cols, existingTerminal.cols)
					: existingTerminal.cols;
			const updatedRows =
				rows !== undefined
					? normalizeTerminalDimension(rows, existingTerminal.rows)
					: existingTerminal.rows;
			await tx
				.update(terminals)
				.set({
					cols: updatedCols,
					rows: updatedRows,
					updatedAt: now,
				})
				.where(eq(terminals.id, terminalId));
		}

		await tx
			.update(tabs)
			.set({ active: true, archivedAt: null, updatedAt: now })
			.where(eq(tabs.id, tabId));
	});

	const existingHandle = ctx.vars.terminalHandles.get(terminalId);
	if (!existingHandle) {
		const sandbox = ctx.vars.sandbox;
		const row = await ctx.vars.db
			.select({
				ptyPid: terminals.ptyPid,
				cols: terminals.cols,
				rows: terminals.rows,
			})
			.from(terminals)
			.where(eq(terminals.id, terminalId))
			.limit(1);

		const terminalRow = row[0];
		if (!terminalRow) {
			throw new Error("Terminal not found");
		}

		const onData = (chunk: Uint8Array) => {
			const bytes = Array.from(chunk);
			const payload: TerminalOutputPayload = {
				terminalId,
				data: bytes,
			};

			publishToChannel(
				ctx,
				createTabChannel("terminal", terminalId),
				TERMINAL_OUTPUT_EVENT_NAME,
				payload
			);
		};

		const { handle, pid } = await connectOrCreatePty(
			sandbox,
			terminalId,
			terminalRow.ptyPid,
			terminalRow.cols,
			terminalRow.rows,
			onData,
			ctx.state.workdir ?? undefined
		);

		const previousHandle = ctx.vars.terminalHandles.get(terminalId);
		if (previousHandle && previousHandle !== handle) {
			try {
				await previousHandle.disconnect();
			} catch (error) {
				log.warn(
					{ terminalId, err: error },
					"failed to disconnect replaced terminal handle"
				);
			}
		}
		ctx.vars.terminalHandles.set(terminalId, handle);
		trackTerminalExit(ctx, terminalId, handle, pid);

		if (pid !== terminalRow.ptyPid) {
			await ctx.vars.db
				.update(terminals)
				.set({ ptyPid: pid, updatedAt: Date.now() })
				.where(eq(terminals.id, terminalId));
		}
	}

	await ctx.broadcastTabsChanged();
}

async function input(
	ctx: SpaceRuntimeContext,
	terminalId: string,
	data: number[]
): Promise<void> {
	if (!ctx.vars.terminalHandles.has(terminalId)) {
		await ensureTerminal(ctx, terminalId);
	}

	const handle = getTerminalHandleOrThrow(ctx, terminalId);
	const sandbox = ctx.vars.sandbox;

	try {
		await sandbox.pty.sendInput(handle.pid, new Uint8Array(data));
	} catch (error) {
		if (!isProcessNotFoundError(error)) {
			throw error;
		}

		log.warn(
			{ terminalId, pid: handle.pid, err: error },
			"terminal pty pid not found during input, recreating handle"
		);
		const refreshedHandle = await recreateTerminalHandle(ctx, terminalId);
		await sandbox.pty.sendInput(refreshedHandle.pid, new Uint8Array(data));
	}
}

async function resize(
	ctx: SpaceRuntimeContext,
	terminalId: string,
	cols: number,
	rows: number
): Promise<void> {
	await ensureTerminal(ctx, terminalId, cols, rows);

	const handle = getTerminalHandleOrThrow(ctx, terminalId);
	const sandbox = ctx.vars.sandbox;

	try {
		await sandbox.pty.resize(handle.pid, { cols, rows });
	} catch (error) {
		if (!isProcessNotFoundError(error)) {
			throw error;
		}

		log.warn(
			{ terminalId, pid: handle.pid, cols, rows, err: error },
			"terminal pty pid not found during resize, recreating handle"
		);
		const refreshedHandle = await recreateTerminalHandle(
			ctx,
			terminalId,
			cols,
			rows
		);
		await sandbox.pty.resize(refreshedHandle.pid, { cols, rows });
	}
}

async function startDevServerAction(
	ctx: SpaceRuntimeContext,
	devCommand: string
): Promise<void> {
	const trimmedDevCommand = devCommand.trim();
	if (!trimmedDevCommand) {
		throw new Error("Dev command must not be empty");
	}

	const sandbox = ctx.vars.sandbox;
	const exists = await hasTmuxSession(sandbox, DEV_SERVER_TERMINAL_ID);
	if (exists) {
		// Already running — just ensure the tab + PTY are attached
		await ensureTerminal(ctx, DEV_SERVER_TERMINAL_ID);
		return;
	}

	const safeSessionName = quoteShellArg(DEV_SERVER_TERMINAL_ID);
	await ensureTmuxSession(
		sandbox,
		DEV_SERVER_TERMINAL_ID,
		ctx.state.workdir ?? undefined
	);

	// Send the dev command literally to avoid shell expansion in the wrapper shell.
	await runRootCommand(
		sandbox,
		`tmux send-keys -t ${safeSessionName} -l -- ${quoteShellArg(trimmedDevCommand)}`
	);
	await runRootCommand(sandbox, `tmux send-keys -t ${safeSessionName} Enter`);

	await ensureTerminal(ctx, DEV_SERVER_TERMINAL_ID);
}

async function openTerminalAction(
	ctx: SpaceRuntimeContext,
	terminalId: string,
	cols?: number,
	rows?: number
): Promise<{ cols: number; rows: number }> {
	if (!ctx.conn) {
		throw new Error("Terminal subscriptions require an active connection");
	}

	const connId = ctx.conn.id;
	const openActionKey = connectionTerminalKey(connId, terminalId);
	const existingOpenAction = ctx.vars.terminalOpenActions.get(openActionKey);
	if (existingOpenAction) {
		await existingOpenAction;
		const [terminal] = await ctx.vars.db
			.select({ cols: terminals.cols, rows: terminals.rows })
			.from(terminals)
			.where(eq(terminals.id, terminalId))
			.limit(1);
		return {
			cols: terminal?.cols ?? DEFAULT_TERMINAL_COLS,
			rows: terminal?.rows ?? DEFAULT_TERMINAL_ROWS,
		};
	}

	const openAction = (async () => {
		subscribeToChannel(
			ctx.vars.subscriptions,
			createTabChannel("terminal", terminalId),
			connId
		);

		const hadHandle = ctx.vars.terminalHandles.has(terminalId);
		await ensureTerminal(ctx, terminalId, cols, rows);

		if (hadHandle) {
			const now = Date.now();
			const snapshotKey = connectionTerminalKey(connId, terminalId);
			const lastSnapshotAt =
				ctx.vars.lastTerminalSnapshotAt.get(snapshotKey) ?? 0;
			if (now - lastSnapshotAt >= SNAPSHOT_DEBOUNCE_MS) {
				await sendTerminalSnapshotToConnection(ctx, terminalId);
				ctx.vars.lastTerminalSnapshotAt.set(snapshotKey, now);
			}
		}
	})();

	ctx.vars.terminalOpenActions.set(openActionKey, openAction);
	try {
		await openAction;
	} finally {
		if (ctx.vars.terminalOpenActions.get(openActionKey) === openAction) {
			ctx.vars.terminalOpenActions.delete(openActionKey);
		}
	}

	const [terminal] = await ctx.vars.db
		.select({ cols: terminals.cols, rows: terminals.rows })
		.from(terminals)
		.where(eq(terminals.id, terminalId))
		.limit(1);
	return {
		cols: terminal?.cols ?? DEFAULT_TERMINAL_COLS,
		rows: terminal?.rows ?? DEFAULT_TERMINAL_ROWS,
	};
}

function closeTerminalAction(
	ctx: SpaceRuntimeContext,
	terminalId: string
): void {
	if (!ctx.conn) {
		throw new Error("Terminal subscriptions require an active connection");
	}

	const connId = ctx.conn.id;
	unsubscribeFromChannel(
		ctx.vars.subscriptions,
		createTabChannel("terminal", terminalId),
		connId
	);
	const key = connectionTerminalKey(connId, terminalId);
	ctx.vars.terminalOpenActions.delete(key);
	ctx.vars.lastTerminalSnapshotAt.delete(key);
}

async function killDevServerAction(ctx: SpaceRuntimeContext): Promise<void> {
	// Disconnect the PTY handle first
	const handle = ctx.vars.terminalHandles.get(DEV_SERVER_TERMINAL_ID);
	if (handle) {
		try {
			await handle.disconnect();
		} catch {
			// Best-effort
		}
		ctx.vars.terminalHandles.delete(DEV_SERVER_TERMINAL_ID);
	}

	// Kill the tmux session
	try {
		const sandbox = ctx.vars.sandbox;
		const safeSessionName = quoteShellArg(DEV_SERVER_TERMINAL_ID);
		await runRootCommand(sandbox, `tmux kill-session -t ${safeSessionName}`);
	} catch (error) {
		if (!(error instanceof CommandExitError)) {
			throw error;
		}
		// Session already gone
	}

	// Archive the tab
	const tabId = createTabId("terminal", DEV_SERVER_TERMINAL_ID);
	await ctx.vars.db
		.update(tabs)
		.set({ active: false, archivedAt: Date.now(), updatedAt: Date.now() })
		.where(eq(tabs.id, tabId));

	await ctx.broadcastTabsChanged();
}

async function onWake(ctx: SpaceRuntimeContext): Promise<void> {
	const sandbox = ctx.vars.sandbox;
	const exists = await hasTmuxSession(sandbox, DEV_SERVER_TERMINAL_ID);
	if (!exists) {
		// Clean up stale tab if tmux session is gone (e.g. sandbox restart)
		const tabId = createTabId("terminal", DEV_SERVER_TERMINAL_ID);
		const now = Date.now();
		ctx.vars.db
			.update(tabs)
			.set({ active: false, archivedAt: now, updatedAt: now })
			.where(eq(tabs.id, tabId))
			.run();
		return;
	}

	const tabId = createTabId("terminal", DEV_SERVER_TERMINAL_ID);
	const now = Date.now();

	ctx.vars.db.transaction((tx) => {
		const existingTab = tx
			.select({ id: tabs.id })
			.from(tabs)
			.where(eq(tabs.id, tabId))
			.limit(1)
			.all();
		const existingTerminal = tx
			.select({ id: terminals.id, tabId: terminals.tabId })
			.from(terminals)
			.where(eq(terminals.id, DEV_SERVER_TERMINAL_ID))
			.limit(1)
			.all();

		if (existingTab.length === 0) {
			tx.insert(tabs)
				.values({
					id: tabId,
					type: "terminal",
					title: "Dev Server",
					active: true,
					createdAt: now,
					updatedAt: now,
					archivedAt: null,
				})
				.run();
		} else {
			tx.update(tabs)
				.set({
					title: "Dev Server",
					active: true,
					archivedAt: null,
					updatedAt: now,
				})
				.where(eq(tabs.id, tabId))
				.run();
		}

		if (existingTerminal.length === 0) {
			tx.insert(terminals)
				.values({
					id: DEV_SERVER_TERMINAL_ID,
					tabId,
					ptyPid: null,
					cols: DEFAULT_TERMINAL_COLS,
					rows: DEFAULT_TERMINAL_ROWS,
					createdAt: now,
					updatedAt: now,
				})
				.run();
		} else if (existingTerminal[0]?.tabId !== tabId) {
			tx.update(terminals)
				.set({ tabId, updatedAt: now })
				.where(eq(terminals.id, DEV_SERVER_TERMINAL_ID))
				.run();
		}
	});
	log.info({ actorId: ctx.actorId }, "terminal.on-wake.devserver-discovered");
}

type TerminalPublicActions = {
	openTerminal: (
		ctx: SpaceRuntimeContext,
		terminalId: string,
		cols?: number,
		rows?: number
	) => Promise<{ cols: number; rows: number }>;
	closeTerminal: (ctx: SpaceRuntimeContext, terminalId: string) => void;
	input: (
		ctx: SpaceRuntimeContext,
		terminalId: string,
		data: number[]
	) => Promise<void>;
	resize: (
		ctx: SpaceRuntimeContext,
		terminalId: string,
		cols: number,
		rows: number
	) => Promise<void>;
	startDevServer: (
		ctx: SpaceRuntimeContext,
		devCommand: string
	) => Promise<void>;
	killDevServer: (ctx: SpaceRuntimeContext) => Promise<void>;
};

type TerminalDriver = TabDriverLifecycle<TerminalPublicActions> & {
	publicActions: TerminalPublicActions;
};

export const terminalDriver: TerminalDriver = {
	kind: "terminal",
	onWake,
	publicActions: {
		openTerminal: openTerminalAction,
		closeTerminal: closeTerminalAction,
		input,
		resize,
		startDevServer: startDevServerAction,
		killDevServer: killDevServerAction,
	},
};
