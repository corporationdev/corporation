import { createLogger } from "@corporation/logger";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { CommandExitError, type CommandHandle, type Sandbox } from "e2b";
import { type TerminalTab, tabs, terminals } from "../db/schema";
import { createTabChannel, createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import { publishToChannel } from "./subscriptions";
import type { SpaceRuntimeContext, SpaceVars } from "./types";

const log = createLogger("space:terminal");
const TERMINAL_OUTPUT_EVENT_NAME = "terminal.output";
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 30;
const PTY_TIMEOUT_MS = 0;
const TMUX_HISTORY_LIMIT = 50_000;
const DEV_SERVER_TERMINAL_ID = "devserver";

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

async function hasTmuxSession(
	sandbox: Sandbox,
	sessionName: string
): Promise<boolean> {
	try {
		await sandbox.commands.run(`tmux has-session -t ${sessionName}`);
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
	const exists = await hasTmuxSession(sandbox, sessionName);
	if (exists) {
		return;
	}

	const cwdFlag = cwd ? ` -c '${cwd}'` : "";
	await sandbox.commands.run(
		`tmux new-session -d -s ${sessionName}${cwdFlag} \\; set-option -t ${sessionName} history-limit ${TMUX_HISTORY_LIMIT} \\; set-option -t ${sessionName} mouse on \\; set-option -t ${sessionName} status off`
	);
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

	const attachCmd = `exec tmux attach-session -t ${sessionName}\n`;
	await sandbox.pty.sendInput(handle.pid, new TextEncoder().encode(attachCmd));

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
	return await createTmuxPty(sandbox, sessionName, cols, rows, onData);
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

async function disconnectAllTerminals(ctx: SpaceRuntimeContext): Promise<void> {
	for (const handle of ctx.vars.terminalHandles.values()) {
		await handle.disconnect();
	}

	ctx.vars.terminalHandles.clear();
}

async function ensureTerminal(
	ctx: SpaceRuntimeContext,
	terminalId: string,
	cols?: number,
	rows?: number
): Promise<void> {
	const now = Date.now();
	const tabId = createTabId("terminal", terminalId);
	const nextCols = cols ?? DEFAULT_TERMINAL_COLS;
	const nextRows = rows ?? DEFAULT_TERMINAL_ROWS;

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
			await tx
				.update(terminals)
				.set({
					cols: cols ?? existingTerminal.cols,
					rows: rows ?? existingTerminal.rows,
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

			publishToChannel(
				ctx,
				createTabChannel("terminal", terminalId),
				TERMINAL_OUTPUT_EVENT_NAME,
				{
					terminalId,
					data: bytes,
				}
			);
		};

		const { handle, pid } = await connectOrCreatePty(
			ctx.vars.sandbox,
			terminalId,
			terminalRow.ptyPid,
			terminalRow.cols,
			terminalRow.rows,
			onData,
			ctx.state.workdir ?? undefined
		);

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

	const handle = ctx.vars.terminalHandles.get(terminalId);
	if (!handle) {
		throw new Error("Terminal handle is not available after ensureTerminal");
	}

	try {
		await ctx.vars.sandbox.pty.sendInput(handle.pid, new Uint8Array(data));
	} catch (error) {
		if (!isProcessNotFoundError(error)) {
			throw error;
		}

		log.warn(
			{ terminalId, pid: handle.pid, err: error },
			"terminal pty pid not found during input, recreating handle"
		);
		const refreshedHandle = await recreateTerminalHandle(ctx, terminalId);
		await ctx.vars.sandbox.pty.sendInput(
			refreshedHandle.pid,
			new Uint8Array(data)
		);
	}
}

async function resize(
	ctx: SpaceRuntimeContext,
	terminalId: string,
	cols: number,
	rows: number
): Promise<void> {
	await ensureTerminal(ctx, terminalId, cols, rows);

	const handle = ctx.vars.terminalHandles.get(terminalId);
	if (!handle) {
		throw new Error("Terminal handle is not available after ensureTerminal");
	}

	try {
		await ctx.vars.sandbox.pty.resize(handle.pid, { cols, rows });
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
		await ctx.vars.sandbox.pty.resize(refreshedHandle.pid, { cols, rows });
	}
}

async function listTabs(ctx: SpaceRuntimeContext): Promise<TerminalTab[]> {
	const rows = await ctx.vars.db
		.select({
			tabId: tabs.id,
			type: tabs.type,
			title: tabs.title,
			active: tabs.active,
			createdAt: tabs.createdAt,
			updatedAt: tabs.updatedAt,
			archivedAt: tabs.archivedAt,
			terminalId: terminals.id,
			terminalCols: terminals.cols,
			terminalRows: terminals.rows,
		})
		.from(tabs)
		.innerJoin(terminals, eq(tabs.id, terminals.tabId))
		.where(
			and(
				eq(tabs.type, "terminal"),
				eq(tabs.active, true),
				isNull(tabs.archivedAt)
			)
		)
		.orderBy(desc(tabs.updatedAt), asc(tabs.createdAt));

	return rows.map((row) => {
		const tab: TerminalTab = {
			id: row.tabId,
			type: "terminal",
			title: row.title,
			active: row.active,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			archivedAt: row.archivedAt,
			terminalId: row.terminalId,
			cols: row.terminalCols,
			rows: row.terminalRows,
		};
		return tab;
	});
}

async function startDevServerAction(
	ctx: SpaceRuntimeContext,
	devCommand: string
): Promise<void> {
	const exists = await hasTmuxSession(ctx.vars.sandbox, DEV_SERVER_TERMINAL_ID);
	if (exists) {
		// Already running — just ensure the tab + PTY are attached
		await ensureTerminal(ctx, DEV_SERVER_TERMINAL_ID);
		return;
	}

	const workdir = ctx.state.workdir ?? undefined;
	const cwdFlag = workdir ? ` -c '${workdir}'` : "";
	await ctx.vars.sandbox.commands.run(
		`tmux new-session -d -s ${DEV_SERVER_TERMINAL_ID}${cwdFlag} \\; set-option -t ${DEV_SERVER_TERMINAL_ID} history-limit ${TMUX_HISTORY_LIMIT} \\; set-option -t ${DEV_SERVER_TERMINAL_ID} mouse on \\; set-option -t ${DEV_SERVER_TERMINAL_ID} status off`
	);

	// Send the dev command into the tmux session so it runs inside the shell
	await ctx.vars.sandbox.commands.run(
		`tmux send-keys -t ${DEV_SERVER_TERMINAL_ID} ${JSON.stringify(devCommand)} Enter`
	);

	await ensureTerminal(ctx, DEV_SERVER_TERMINAL_ID);
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
		await ctx.vars.sandbox.commands.run(
			`tmux kill-session -t ${DEV_SERVER_TERMINAL_ID}`
		);
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

async function onWake(vars: SpaceVars): Promise<void> {
	const exists = await hasTmuxSession(vars.sandbox, DEV_SERVER_TERMINAL_ID);
	if (!exists) {
		return;
	}

	const tabId = createTabId("terminal", DEV_SERVER_TERMINAL_ID);
	const now = Date.now();

	const existingTab = await vars.db
		.select({ id: tabs.id })
		.from(tabs)
		.where(eq(tabs.id, tabId))
		.limit(1);

	if (existingTab.length === 0) {
		await vars.db.insert(tabs).values({
			id: tabId,
			type: "terminal",
			title: "Dev Server",
			active: true,
			createdAt: now,
			updatedAt: now,
			archivedAt: null,
		});
		await vars.db.insert(terminals).values({
			id: DEV_SERVER_TERMINAL_ID,
			tabId,
			ptyPid: null,
			cols: DEFAULT_TERMINAL_COLS,
			rows: DEFAULT_TERMINAL_ROWS,
			createdAt: now,
			updatedAt: now,
		});
	} else {
		await vars.db
			.update(tabs)
			.set({ active: true, archivedAt: null, updatedAt: now })
			.where(eq(tabs.id, tabId));
	}

	log.info("auto-discovered devserver tmux session on wake");
}

async function onSleep(ctx: SpaceRuntimeContext): Promise<void> {
	await disconnectAllTerminals(ctx);
}

type TerminalPublicActions = {
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
	onSleep,
	listTabs,
	publicActions: {
		input,
		resize,
		startDevServer: startDevServerAction,
		killDevServer: killDevServerAction,
	},
};
