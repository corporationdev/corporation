import { createLogger } from "@corporation/logger";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { CommandHandle, Sandbox } from "e2b";
import { type TerminalTab, tabs, terminals } from "../db/schema";
import { createTabChannel, createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import { publishToChannel } from "./subscriptions";
import type { SpaceRuntimeContext } from "./types";

const log = createLogger("space:terminal");
const TERMINAL_OUTPUT_EVENT_NAME = "terminal.output";
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 30;
const MAX_SCROLLBACK_BYTES = 256 * 1024;

function encodeBytes(bytes: number[]): string {
	if (bytes.length === 0) {
		return "";
	}

	let binary = "";
	const chunkSize = 8192;

	for (let index = 0; index < bytes.length; index += chunkSize) {
		const chunk = bytes.slice(index, index + chunkSize);
		for (const value of chunk) {
			binary += String.fromCharCode(value);
		}
	}

	return btoa(binary);
}

function decodeBytes(encoded: string | null): number[] {
	if (!encoded) {
		return [];
	}

	const binary = atob(encoded);
	const bytes: number[] = new Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function appendAndTrimBuffer(base: number[], next: number[]): number[] {
	if (next.length === 0) {
		return base;
	}

	const combined = base.concat(next);
	if (combined.length <= MAX_SCROLLBACK_BYTES) {
		return combined;
	}

	return combined.slice(combined.length - MAX_SCROLLBACK_BYTES);
}

async function connectOrCreatePty(
	sandbox: Sandbox,
	existingPid: number | null,
	cols: number,
	rows: number,
	onData: (data: Uint8Array) => void,
	cwd?: string
): Promise<{ handle: CommandHandle; pid: number }> {
	if (existingPid !== null) {
		try {
			const handle = await sandbox.pty.connect(existingPid, {
				onData,
			});
			return { handle, pid: existingPid };
		} catch {
			log.warn(
				{ pid: existingPid },
				"failed to reconnect pty, creating a new one"
			);
		}
	}

	const handle = await sandbox.pty.create({
		cols,
		rows,
		onData,
		user: "root",
		cwd,
	});

	return { handle, pid: handle.pid };
}

async function disconnectAllTerminals(ctx: SpaceRuntimeContext): Promise<void> {
	for (const handle of ctx.vars.terminalHandles.values()) {
		await handle.disconnect();
	}

	await Promise.all(ctx.vars.terminalPersistWrites.values());
	ctx.vars.terminalHandles.clear();
	ctx.vars.terminalBuffers.clear();
	ctx.vars.terminalPersistWrites.clear();
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
			await tx.insert(tabs).values({
				id: tabId,
				type: "terminal",
				title: "Terminal",
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
				scrollbackBlob: null,
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
				scrollbackBlob: terminals.scrollbackBlob,
			})
			.from(terminals)
			.where(eq(terminals.id, terminalId))
			.limit(1);

		const terminalRow = row[0];
		if (!terminalRow) {
			throw new Error("Terminal not found");
		}

		const existingBuffer = decodeBytes(terminalRow.scrollbackBlob);
		ctx.vars.terminalBuffers.set(terminalId, existingBuffer);

		const onData = (chunk: Uint8Array) => {
			const bytes = Array.from(chunk);
			const currentBuffer = ctx.vars.terminalBuffers.get(terminalId) ?? [];
			const nextBuffer = appendAndTrimBuffer(currentBuffer, bytes);
			ctx.vars.terminalBuffers.set(terminalId, nextBuffer);

			publishToChannel(
				ctx,
				createTabChannel("terminal", terminalId),
				TERMINAL_OUTPUT_EVENT_NAME,
				{
					terminalId,
					data: bytes,
				}
			);

			const previousWrite =
				ctx.vars.terminalPersistWrites.get(terminalId) ?? Promise.resolve();
			const persistWrite = previousWrite
				.catch(() => undefined)
				.then(async () => {
					const latestBuffer = ctx.vars.terminalBuffers.get(terminalId) ?? [];
					await ctx.vars.db
						.update(terminals)
						.set({
							scrollbackBlob: encodeBytes(latestBuffer),
							updatedAt: Date.now(),
						})
						.where(eq(terminals.id, terminalId));
				})
				.catch((error) => {
					log.error(
						{ terminalId, err: error },
						"failed to persist terminal scrollback"
					);
				});

			ctx.vars.terminalPersistWrites.set(terminalId, persistWrite);
			ctx.waitUntil(
				persistWrite.finally(() => {
					if (ctx.vars.terminalPersistWrites.get(terminalId) === persistWrite) {
						ctx.vars.terminalPersistWrites.delete(terminalId);
					}
				})
			);
		};

		const { handle, pid } = await connectOrCreatePty(
			ctx.vars.sandbox,
			terminalRow.ptyPid,
			terminalRow.cols,
			terminalRow.rows,
			onData,
			ctx.state.workdir ?? undefined
		);

		ctx.vars.terminalHandles.set(terminalId, handle);

		if (pid !== terminalRow.ptyPid) {
			await ctx.vars.db
				.update(terminals)
				.set({ ptyPid: pid, updatedAt: Date.now() })
				.where(eq(terminals.id, terminalId));
		}
	}

	await ctx.broadcastTabsChanged();
}

async function getScrollback(
	ctx: SpaceRuntimeContext,
	terminalId: string
): Promise<number[]> {
	if (!ctx.vars.terminalHandles.has(terminalId)) {
		await ensureTerminal(ctx, terminalId);
	}

	const inMemory = ctx.vars.terminalBuffers.get(terminalId);
	if (inMemory) {
		return inMemory;
	}

	const rows = await ctx.vars.db
		.select({ scrollbackBlob: terminals.scrollbackBlob })
		.from(terminals)
		.where(eq(terminals.id, terminalId))
		.limit(1);

	const bytes = decodeBytes(rows[0]?.scrollbackBlob ?? null);
	ctx.vars.terminalBuffers.set(terminalId, bytes);
	return bytes;
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

	await ctx.vars.sandbox.pty.sendInput(handle.pid, new Uint8Array(data));
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

	await ctx.vars.sandbox.pty.resize(handle.pid, { cols, rows });
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

async function onSleep(ctx: SpaceRuntimeContext): Promise<void> {
	await disconnectAllTerminals(ctx);
}

type TerminalPublicActions = {
	getScrollback: (
		ctx: SpaceRuntimeContext,
		terminalId: string
	) => Promise<number[]>;
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
};

type TerminalDriver = TabDriverLifecycle<TerminalPublicActions> & {
	publicActions: TerminalPublicActions;
};

export const terminalDriver: TerminalDriver = {
	kind: "terminal",
	onSleep,
	listTabs,
	publicActions: {
		getScrollback,
		input,
		resize,
	},
};
