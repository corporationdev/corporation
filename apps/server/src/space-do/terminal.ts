import { createLogger } from "@corporation/logger";
import { CommandExitError, type CommandHandle, type Sandbox } from "e2b";
import { requireSandbox } from "./sandbox";
import type { SpaceRuntimeContext } from "./types";

const log = createLogger("space:terminal");
const TERMINAL_ID = "workspace";
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const PTY_TIMEOUT_MS = 0;
const TMUX_HISTORY_LIMIT = 2000;
const SANDBOX_USER = "user";
const ENCODER = new TextEncoder();

type TerminalOutputPayload = {
	terminalId: string;
	data: number[];
	snapshot?: boolean;
};

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function runTerminalCommand(sandbox: Sandbox, command: string) {
	return sandbox.commands.run(command, { user: SANDBOX_USER });
}

function toBytes(value: string): number[] {
	return Array.from(ENCODER.encode(value));
}

function normalizeDimension(
	value: number | undefined,
	fallback: number
): number {
	if (!(typeof value === "number" && Number.isFinite(value))) {
		return fallback;
	}
	const n = Math.floor(value);
	return n > 0 ? n : fallback;
}

function isProcessNotFoundError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "NotFoundError" &&
		error.message.includes("process with pid") &&
		error.message.includes("not found")
	);
}

async function hasTmuxSession(sandbox: Sandbox): Promise<boolean> {
	try {
		await runTerminalCommand(
			sandbox,
			`tmux has-session -t ${quoteShellArg(TERMINAL_ID)}`
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
	cwd?: string
): Promise<void> {
	const safeName = quoteShellArg(TERMINAL_ID);

	if (await hasTmuxSession(sandbox)) {
		await runTerminalCommand(
			sandbox,
			`tmux set-option -t ${safeName} history-limit ${TMUX_HISTORY_LIMIT} \\; set-option -t ${safeName} mouse off \\; set-option -t ${safeName} status off`
		);
		return;
	}

	let cwdFlag = "";
	if (cwd) {
		await runTerminalCommand(sandbox, `test -d ${quoteShellArg(cwd)}`);
		cwdFlag = ` -c ${quoteShellArg(cwd)}`;
	}

	try {
		await runTerminalCommand(
			sandbox,
			`tmux new-session -d -s ${safeName}${cwdFlag}`
		);
	} catch (error) {
		if (!(error instanceof CommandExitError)) {
			throw error;
		}
		if (!(await hasTmuxSession(sandbox))) {
			throw error;
		}
	}

	await runTerminalCommand(
		sandbox,
		`tmux set-option -t ${safeName} history-limit ${TMUX_HISTORY_LIMIT} \\; set-option -t ${safeName} mouse off \\; set-option -t ${safeName} status off`
	);
}

async function ensureTerminal(
	ctx: SpaceRuntimeContext,
	cols?: number,
	rows?: number
): Promise<void> {
	const existing = ctx.vars.terminalHandles.get(TERMINAL_ID);
	if (existing) {
		return;
	}

	const sandbox = requireSandbox(ctx);
	const normalizedCols = normalizeDimension(cols, DEFAULT_COLS);
	const normalizedRows = normalizeDimension(rows, DEFAULT_ROWS);

	await ensureTmuxSession(sandbox, ctx.state.binding?.workdir);

	const onData = (chunk: Uint8Array) => {
		const payload: TerminalOutputPayload = {
			terminalId: TERMINAL_ID,
			data: Array.from(chunk),
		};
		ctx.broadcast("terminal.output", payload);
	};

	const handle = await sandbox.pty.create({
		cols: normalizedCols,
		rows: normalizedRows,
		onData,
		timeoutMs: PTY_TIMEOUT_MS,
		user: SANDBOX_USER,
	});

	const attachCmd = `exec tmux attach-session -t ${quoteShellArg(TERMINAL_ID)}\n`;
	await sandbox.pty.sendInput(handle.pid, ENCODER.encode(attachCmd));

	ctx.vars.terminalHandles.set(TERMINAL_ID, handle);

	handle
		.wait()
		.catch((error) => {
			log.info({ pid: handle.pid, err: error }, "terminal pty exited");
		})
		.then(() => {
			if (ctx.vars.terminalHandles.get(TERMINAL_ID) === handle) {
				ctx.vars.terminalHandles.delete(TERMINAL_ID);
			}
		})
		.catch(() => {
			// Best-effort cleanup, ignore errors
		});
}

async function disconnectTerminalHandle(handle: CommandHandle): Promise<void> {
	try {
		await handle.disconnect();
	} catch {
		// Best-effort disconnect
	}
}

function broadcastSnapshot(
	ctx: SpaceRuntimeContext,
	payload: TerminalOutputPayload
) {
	for (const connection of ctx.conns.values()) {
		connection.send("terminal.output", payload);
	}
}

function buildEmptySnapshotPayload(): TerminalOutputPayload {
	return {
		terminalId: TERMINAL_ID,
		snapshot: true,
		data: [],
	};
}

async function recreateHandle(
	ctx: SpaceRuntimeContext,
	cols?: number,
	rows?: number
): Promise<CommandHandle> {
	const previous = ctx.vars.terminalHandles.get(TERMINAL_ID);
	if (previous) {
		await disconnectTerminalHandle(previous);
	}
	ctx.vars.terminalHandles.delete(TERMINAL_ID);
	await ensureTerminal(ctx, cols, rows);
	const handle = ctx.vars.terminalHandles.get(TERMINAL_ID);
	if (!handle) {
		throw new Error("Terminal handle not available after recreation");
	}
	return handle;
}

async function captureSnapshotPayload(
	ctx: SpaceRuntimeContext
): Promise<TerminalOutputPayload | null> {
	await ensureTerminal(ctx);

	try {
		const result = await runTerminalCommand(
			requireSandbox(ctx),
			`tmux capture-pane -p -e -J -t ${quoteShellArg(TERMINAL_ID)} -S -`
		);
		if (result.stdout) {
			// Trim trailing empty lines so the cursor doesn't start at the bottom
			const trimmed = result.stdout.replace(/\n\s*$/g, "\n");
			return {
				terminalId: TERMINAL_ID,
				snapshot: true,
				data: toBytes(trimmed),
			};
		}
	} catch (error) {
		if (!(error instanceof CommandExitError)) {
			throw error;
		}
	}

	return null;
}

export async function resetTerminal(ctx: SpaceRuntimeContext): Promise<void> {
	const previous = ctx.vars.terminalHandles.get(TERMINAL_ID);
	if (previous) {
		await disconnectTerminalHandle(previous);
	}
	ctx.vars.terminalHandles.delete(TERMINAL_ID);
	broadcastSnapshot(ctx, buildEmptySnapshotPayload());
}

export async function broadcastTerminalSnapshot(
	ctx: SpaceRuntimeContext
): Promise<boolean> {
	const payload = await captureSnapshotPayload(ctx);
	if (!payload) {
		return false;
	}

	broadcastSnapshot(ctx, payload);
	return true;
}

export async function getTerminalSnapshot(
	ctx: SpaceRuntimeContext
): Promise<boolean> {
	if (!ctx.conn) {
		return false;
	}
	const connection = ctx.conns.get(ctx.conn.id);
	if (!connection) {
		return false;
	}

	const payload = await captureSnapshotPayload(ctx);
	if (!payload) {
		return false;
	}

	connection.send("terminal.output", payload);
	return true;
}

export async function input(
	ctx: SpaceRuntimeContext,
	data: number[]
): Promise<void> {
	if (!ctx.vars.terminalHandles.has(TERMINAL_ID)) {
		await ensureTerminal(ctx);
	}

	const handle = ctx.vars.terminalHandles.get(TERMINAL_ID);
	if (!handle) {
		throw new Error("Terminal handle not available");
	}

	try {
		await requireSandbox(ctx).pty.sendInput(handle.pid, new Uint8Array(data));
	} catch (error) {
		if (!isProcessNotFoundError(error)) {
			throw error;
		}
		log.warn({ pid: handle.pid }, "pty not found, recreating");
		const refreshed = await recreateHandle(ctx);
		await requireSandbox(ctx).pty.sendInput(
			refreshed.pid,
			new Uint8Array(data)
		);
	}
}

export async function resize(
	ctx: SpaceRuntimeContext,
	cols: number,
	rows: number
): Promise<void> {
	await ensureTerminal(ctx, cols, rows);

	const handle = ctx.vars.terminalHandles.get(TERMINAL_ID);
	if (!handle) {
		throw new Error("Terminal handle not available");
	}

	try {
		await requireSandbox(ctx).pty.resize(handle.pid, { cols, rows });
	} catch (error) {
		if (!isProcessNotFoundError(error)) {
			throw error;
		}
		log.warn({ pid: handle.pid }, "pty not found during resize, recreating");
		const refreshed = await recreateHandle(ctx, cols, rows);
		await requireSandbox(ctx).pty.resize(refreshed.pid, { cols, rows });
	}
}
