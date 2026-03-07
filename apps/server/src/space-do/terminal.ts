import { createLogger } from "@corporation/logger";
import { CommandExitError, type CommandHandle, type Sandbox } from "e2b";
import type { SpaceRuntimeContext } from "./types";

const log = createLogger("space:terminal");
const TERMINAL_ID = "workspace";
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const PTY_TIMEOUT_MS = 0;
const TMUX_HISTORY_LIMIT = 2000;
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
		await runRootCommand(
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
		await runRootCommand(
			sandbox,
			`tmux set-option -t ${safeName} history-limit ${TMUX_HISTORY_LIMIT} \\; set-option -t ${safeName} mouse off \\; set-option -t ${safeName} status off`
		);
		return;
	}

	let cwdFlag = "";
	if (cwd) {
		try {
			await runRootCommand(sandbox, `test -d ${quoteShellArg(cwd)}`);
			cwdFlag = ` -c ${quoteShellArg(cwd)}`;
		} catch (error) {
			if (!(error instanceof CommandExitError)) {
				throw error;
			}
		}
	}

	try {
		await runRootCommand(
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

	await runRootCommand(
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

	const sandbox = ctx.vars.sandbox;
	const normalizedCols = normalizeDimension(cols, DEFAULT_COLS);
	const normalizedRows = normalizeDimension(rows, DEFAULT_ROWS);

	await ensureTmuxSession(sandbox, ctx.state.workdir ?? undefined);

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
		user: "root",
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

async function recreateHandle(
	ctx: SpaceRuntimeContext,
	cols?: number,
	rows?: number
): Promise<CommandHandle> {
	const previous = ctx.vars.terminalHandles.get(TERMINAL_ID);
	if (previous) {
		try {
			await previous.disconnect();
		} catch {
			// Best-effort disconnect
		}
	}
	ctx.vars.terminalHandles.delete(TERMINAL_ID);
	await ensureTerminal(ctx, cols, rows);
	const handle = ctx.vars.terminalHandles.get(TERMINAL_ID);
	if (!handle) {
		throw new Error("Terminal handle not available after recreation");
	}
	return handle;
}

export async function getTerminalSnapshot(
	ctx: SpaceRuntimeContext
): Promise<void> {
	await ensureTerminal(ctx);

	if (!ctx.conn) {
		return;
	}
	const connection = ctx.conns.get(ctx.conn.id);
	if (!connection) {
		return;
	}

	try {
		const result = await runRootCommand(
			ctx.vars.sandbox,
			`tmux capture-pane -p -e -t ${quoteShellArg(TERMINAL_ID)} -S -`
		);
		if (result.stdout) {
			// Trim trailing empty lines so the cursor doesn't start at the bottom
			const trimmed = result.stdout.replace(/\n\s*$/g, "\n");
			const payload: TerminalOutputPayload = {
				terminalId: TERMINAL_ID,
				snapshot: true,
				data: toBytes(trimmed),
			};
			connection.send("terminal.output", payload);
		}
	} catch (error) {
		if (!(error instanceof CommandExitError)) {
			throw error;
		}
	}
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
		await ctx.vars.sandbox.pty.sendInput(handle.pid, new Uint8Array(data));
	} catch (error) {
		if (!isProcessNotFoundError(error)) {
			throw error;
		}
		log.warn({ pid: handle.pid }, "pty not found, recreating");
		const refreshed = await recreateHandle(ctx);
		await ctx.vars.sandbox.pty.sendInput(refreshed.pid, new Uint8Array(data));
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
		await ctx.vars.sandbox.pty.resize(handle.pid, { cols, rows });
	} catch (error) {
		if (!isProcessNotFoundError(error)) {
			throw error;
		}
		log.warn({ pid: handle.pid }, "pty not found during resize, recreating");
		const refreshed = await recreateHandle(ctx, cols, rows);
		await ctx.vars.sandbox.pty.resize(refreshed.pid, { cols, rows });
	}
}
