import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import type { PtyHandle, Sandbox } from "@daytonaio/sdk";
import { Daytona } from "@daytonaio/sdk";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { nanoid } from "nanoid";
import { actor } from "rivetkit";
import type { UniversalEvent } from "sandbox-agent";
import {
	SandboxAgent as SandboxAgentClient,
	SandboxAgentError,
} from "sandbox-agent";
import bundledMigrations from "./db/migrations/migrations.js";
import {
	type SessionTab,
	type SpaceTab,
	sessionEvents,
	sessions,
	type TabType,
	type TerminalTab,
	tabs,
	terminals,
} from "./db/schema";

export type {
	SessionStatus,
	SessionTab,
	SpaceTab,
	TabType,
	TerminalTab,
} from "./db/schema";

const log = createLogger("space");

const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 30;
const MAX_SCROLLBACK_BYTES = 256 * 1024;

type PersistedState = {
	spaceSlug: string;
	sandboxUrl: string | null;
	sandboxId: string | null;
};

type SpaceDatabase = ReturnType<typeof drizzle>;

type SessionStreamHandle = {
	abortController: AbortController;
};

type SessionSubscriberMap = Map<string, Set<string>>;
type TerminalSubscriberMap = Map<string, Set<string>>;

type SpaceVars = {
	db: SpaceDatabase;
	daytona: Daytona;
	sandboxClient: SandboxAgentClient | null;
	sessionStreams: Map<string, SessionStreamHandle>;
	terminalHandles: Map<string, PtyHandle>;
	terminalBuffers: Map<string, number[]>;
	sessionSubscribers: SessionSubscriberMap;
	terminalSubscribers: TerminalSubscriberMap;
};

function createTabId(type: TabType, entityId: string): string {
	return `${type}_${entityId}`;
}

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

function addSubscriber(
	map: Map<string, Set<string>>,
	key: string,
	connId: string
) {
	let subscribers = map.get(key);
	if (!subscribers) {
		subscribers = new Set();
		map.set(key, subscribers);
	}
	subscribers.add(connId);
}

function removeSubscriber(
	map: Map<string, Set<string>>,
	key: string,
	connId: string
) {
	const subscribers = map.get(key);
	if (!subscribers) {
		return;
	}

	subscribers.delete(connId);
	if (subscribers.size === 0) {
		map.delete(key);
	}
}

function removeConnFromSubscriberMap(
	map: Map<string, Set<string>>,
	connId: string
) {
	for (const [key, subscribers] of map.entries()) {
		subscribers.delete(connId);
		if (subscribers.size === 0) {
			map.delete(key);
		}
	}
}

async function ensureRemoteSessionExists(
	client: SandboxAgentClient,
	sessionId: string
): Promise<void> {
	try {
		await client.createSession(sessionId, { agent: "claude" });
	} catch (error) {
		if (error instanceof SandboxAgentError && error.status === 409) {
			return;
		}
		throw error;
	}
}

async function connectOrCreatePty(
	sandbox: Sandbox,
	ptySessionId: string | null,
	cols: number,
	rows: number,
	onData: (data: Uint8Array) => void
): Promise<{ handle: PtyHandle; sessionId: string }> {
	if (ptySessionId) {
		try {
			const handle = await sandbox.process.connectPty(ptySessionId, { onData });
			return { handle, sessionId: ptySessionId };
		} catch {
			log.warn(
				{ ptySessionId },
				"failed to reconnect pty session, creating a new one"
			);
		}
	}

	const workDir = await sandbox.getWorkDir();
	const nextPtySessionId = nanoid();
	const handle = await sandbox.process.createPty({
		id: nextPtySessionId,
		cwd: workDir,
		cols,
		rows,
		onData,
	});

	return { handle, sessionId: nextPtySessionId };
}

async function persistSessionEvent(
	c: {
		vars: SpaceVars;
		conns: Map<
			string,
			{ send: (eventName: string, ...args: unknown[]) => void }
		>;
	},
	sessionId: string,
	event: UniversalEvent
): Promise<void> {
	const sequence = event.sequence ?? 0;
	if (sequence <= 0) {
		return;
	}

	await c.vars.db
		.insert(sessionEvents)
		.values({
			sessionId,
			sequence,
			eventJson: JSON.stringify(event),
			createdAt: Date.now(),
		})
		.onConflictDoNothing();

	const subscribers = c.vars.sessionSubscribers.get(sessionId);
	if (!subscribers) {
		return;
	}

	for (const connId of subscribers) {
		const subscriber = c.conns.get(connId);
		subscriber?.send("session.event", event);
	}
}

export const space = actor({
	createState: (
		c,
		input?: {
			sandboxUrl?: string;
			sandboxId?: string;
		}
	): PersistedState => {
		const spaceSlug = c.key[0];
		if (!spaceSlug) {
			throw new Error("Actor key must contain a spaceSlug");
		}

		return {
			spaceSlug,
			sandboxUrl: input?.sandboxUrl ?? null,
			sandboxId: input?.sandboxId ?? null,
		};
	},

	createVars: async (c, driverCtx: DriverContext): Promise<SpaceVars> => {
		const db = drizzle(driverCtx.state.storage, {
			schema: {
				tabs,
				sessions,
				sessionEvents,
				terminals,
			},
		});

		await migrate(db, bundledMigrations);

		const sandboxClient = c.state.sandboxUrl
			? await SandboxAgentClient.connect({ baseUrl: c.state.sandboxUrl })
			: null;

		return {
			db,
			daytona: new Daytona({ apiKey: env.DAYTONA_API_KEY }),
			sandboxClient,
			sessionStreams: new Map(),
			terminalHandles: new Map(),
			terminalBuffers: new Map(),
			sessionSubscribers: new Map(),
			terminalSubscribers: new Map(),
		};
	},

	onDisconnect: (c, conn) => {
		removeConnFromSubscriberMap(c.vars.sessionSubscribers, conn.id);
		removeConnFromSubscriberMap(c.vars.terminalSubscribers, conn.id);
	},

	onSleep: async (c) => {
		for (const streamHandle of c.vars.sessionStreams.values()) {
			streamHandle.abortController.abort();
		}
		c.vars.sessionStreams.clear();

		for (const ptyHandle of c.vars.terminalHandles.values()) {
			await ptyHandle.disconnect();
		}
		c.vars.terminalHandles.clear();
		c.vars.terminalBuffers.clear();
		c.vars.sessionSubscribers.clear();
		c.vars.terminalSubscribers.clear();
	},

	actions: {
		setSandboxContext: async (
			c,
			sandboxId: string | null,
			sandboxUrl?: string | null
		) => {
			if (sandboxId !== c.state.sandboxId) {
				for (const ptyHandle of c.vars.terminalHandles.values()) {
					await ptyHandle.disconnect();
				}
				c.vars.terminalHandles.clear();
				c.state.sandboxId = sandboxId;
			}

			if (sandboxUrl !== undefined && sandboxUrl !== c.state.sandboxUrl) {
				c.state.sandboxUrl = sandboxUrl;
				c.vars.sandboxClient = sandboxUrl
					? await SandboxAgentClient.connect({ baseUrl: sandboxUrl })
					: null;

				for (const streamHandle of c.vars.sessionStreams.values()) {
					streamHandle.abortController.abort();
				}
				c.vars.sessionStreams.clear();
			}
		},

		ensureSession: async (c, sessionId: string, title?: string) => {
			const now = Date.now();
			const tabId = createTabId("session", sessionId);
			const nextTitle = title ?? "New Chat";

			await c.vars.db.transaction(async (tx) => {
				const existing = await tx
					.select({ id: sessions.id })
					.from(sessions)
					.where(eq(sessions.id, sessionId))
					.limit(1);

				if (existing.length === 0) {
					await tx.insert(tabs).values({
						id: tabId,
						type: "session",
						title: nextTitle,
						createdAt: now,
						updatedAt: now,
						archivedAt: null,
					});

					await tx.insert(sessions).values({
						id: sessionId,
						tabId,
						status: "waiting",
						createdAt: now,
						updatedAt: now,
					});
					return;
				}

				if (title) {
					await tx
						.update(tabs)
						.set({ title, updatedAt: now })
						.where(eq(tabs.id, tabId));
				}
			});

			c.broadcast("tabs.changed");
		},

		ensureTerminal: async (
			c,
			terminalId: string,
			cols?: number,
			rows?: number
		) => {
			const now = Date.now();
			const tabId = createTabId("terminal", terminalId);
			const nextCols = cols ?? DEFAULT_TERMINAL_COLS;
			const nextRows = rows ?? DEFAULT_TERMINAL_ROWS;

			await c.vars.db.transaction(async (tx) => {
				const existing = await tx
					.select({ id: terminals.id })
					.from(terminals)
					.where(eq(terminals.id, terminalId))
					.limit(1);

				if (existing.length === 0) {
					await tx.insert(tabs).values({
						id: tabId,
						type: "terminal",
						title: "Terminal",
						createdAt: now,
						updatedAt: now,
						archivedAt: null,
					});

					await tx.insert(terminals).values({
						id: terminalId,
						tabId,
						ptySessionId: null,
						cols: nextCols,
						rows: nextRows,
						scrollbackBlob: null,
						createdAt: now,
						updatedAt: now,
					});
					return;
				}

				if (cols !== undefined || rows !== undefined) {
					await tx
						.update(terminals)
						.set({
							cols: cols ?? nextCols,
							rows: rows ?? nextRows,
							updatedAt: now,
						})
						.where(eq(terminals.id, terminalId));
				}
			});

			const existingHandle = c.vars.terminalHandles.get(terminalId);
			if (!existingHandle) {
				if (!c.state.sandboxId) {
					throw new Error("Sandbox is not ready for terminal operations");
				}

				const row = await c.vars.db
					.select({
						ptySessionId: terminals.ptySessionId,
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

				const sandbox = await c.vars.daytona.get(c.state.sandboxId);
				const existingBuffer = decodeBytes(terminalRow.scrollbackBlob);
				c.vars.terminalBuffers.set(terminalId, existingBuffer);

				const onData = (chunk: Uint8Array) => {
					c.waitUntil(
						(async () => {
							const bytes = Array.from(chunk);
							const currentBuffer =
								c.vars.terminalBuffers.get(terminalId) ?? [];
							const nextBuffer = appendAndTrimBuffer(currentBuffer, bytes);
							c.vars.terminalBuffers.set(terminalId, nextBuffer);

							await c.vars.db
								.update(terminals)
								.set({
									scrollbackBlob: encodeBytes(nextBuffer),
									updatedAt: Date.now(),
								})
								.where(eq(terminals.id, terminalId));

							const subscribers =
								c.vars.terminalSubscribers.get(terminalId) ?? new Set<string>();
							for (const connId of subscribers) {
								const subscriber = c.conns.get(connId);
								subscriber?.send("terminal.output", {
									terminalId,
									data: bytes,
								});
							}
						})()
					);
				};

				const { handle, sessionId } = await connectOrCreatePty(
					sandbox,
					terminalRow.ptySessionId,
					terminalRow.cols,
					terminalRow.rows,
					onData
				);

				c.vars.terminalHandles.set(terminalId, handle);

				if (sessionId !== terminalRow.ptySessionId) {
					await c.vars.db
						.update(terminals)
						.set({ ptySessionId: sessionId, updatedAt: Date.now() })
						.where(eq(terminals.id, terminalId));
				}
			}

			c.broadcast("tabs.changed");
		},

		listTabs: async (c): Promise<SpaceTab[]> => {
			const rows = await c.vars.db
				.select({
					tabId: tabs.id,
					type: tabs.type,
					title: tabs.title,
					createdAt: tabs.createdAt,
					updatedAt: tabs.updatedAt,
					archivedAt: tabs.archivedAt,
					sessionId: sessions.id,
					sessionStatus: sessions.status,
					terminalId: terminals.id,
					terminalCols: terminals.cols,
					terminalRows: terminals.rows,
				})
				.from(tabs)
				.leftJoin(sessions, eq(tabs.id, sessions.tabId))
				.leftJoin(terminals, eq(tabs.id, terminals.tabId))
				.where(isNull(tabs.archivedAt))
				.orderBy(desc(tabs.updatedAt), asc(tabs.createdAt));

			return rows
				.map((row) => {
					if (row.type === "session" && row.sessionId && row.sessionStatus) {
						const tab: SessionTab = {
							id: row.tabId,
							type: "session",
							title: row.title,
							createdAt: row.createdAt,
							updatedAt: row.updatedAt,
							archivedAt: row.archivedAt,
							sessionId: row.sessionId,
							status: row.sessionStatus,
						};
						return tab;
					}

					if (
						row.type === "terminal" &&
						row.terminalId &&
						row.terminalCols !== null &&
						row.terminalRows !== null
					) {
						const tab: TerminalTab = {
							id: row.tabId,
							type: "terminal",
							title: row.title,
							createdAt: row.createdAt,
							updatedAt: row.updatedAt,
							archivedAt: row.archivedAt,
							terminalId: row.terminalId,
							cols: row.terminalCols,
							rows: row.terminalRows,
						};
						return tab;
					}

					return null;
				})
				.filter((value): value is SpaceTab => value !== null);
		},

		subscribeSession: (c, sessionId: string) => {
			if (!c.conn) {
				throw new Error("Session subscriptions require an active connection");
			}
			addSubscriber(c.vars.sessionSubscribers, sessionId, c.conn.id);
		},

		unsubscribeSession: (c, sessionId: string) => {
			if (!c.conn) {
				throw new Error("Session subscriptions require an active connection");
			}
			removeSubscriber(c.vars.sessionSubscribers, sessionId, c.conn.id);
		},

		subscribeTerminal: (c, terminalId: string) => {
			if (!c.conn) {
				throw new Error("Terminal subscriptions require an active connection");
			}
			addSubscriber(c.vars.terminalSubscribers, terminalId, c.conn.id);
		},

		unsubscribeTerminal: (c, terminalId: string) => {
			if (!c.conn) {
				throw new Error("Terminal subscriptions require an active connection");
			}
			removeSubscriber(c.vars.terminalSubscribers, terminalId, c.conn.id);
		},

		postMessage: async (
			c,
			sessionId: string,
			content: string,
			sandboxUrl?: string
		) => {
			if (sandboxUrl && sandboxUrl !== c.state.sandboxUrl) {
				c.state.sandboxUrl = sandboxUrl;
				c.vars.sandboxClient = await SandboxAgentClient.connect({
					baseUrl: sandboxUrl,
				});
				for (const streamHandle of c.vars.sessionStreams.values()) {
					streamHandle.abortController.abort();
				}
				c.vars.sessionStreams.clear();
			}

			if (!c.vars.sandboxClient) {
				if (!c.state.sandboxUrl) {
					throw new Error("Sandbox is not ready for session operations");
				}
				c.vars.sandboxClient = await SandboxAgentClient.connect({
					baseUrl: c.state.sandboxUrl,
				});
			}
			const sandboxClient = c.vars.sandboxClient;
			if (!sandboxClient) {
				throw new Error("Sandbox is not ready for session operations");
			}

			await ensureRemoteSessionExists(sandboxClient, sessionId);

			if (!c.vars.sessionStreams.has(sessionId)) {
				const lastSequenceRows = await c.vars.db
					.select({
						lastSequence: sql<number>`coalesce(max(${sessionEvents.sequence}), 0)`,
					})
					.from(sessionEvents)
					.where(eq(sessionEvents.sessionId, sessionId));

				const lastSequence = lastSequenceRows[0]?.lastSequence ?? 0;
				const abortController = new AbortController();
				c.vars.sessionStreams.set(sessionId, { abortController });

				c.waitUntil(
					(async () => {
						try {
							for await (const event of sandboxClient.streamEvents(
								sessionId,
								{ offset: lastSequence },
								abortController.signal
							)) {
								await persistSessionEvent(c, sessionId, event);
							}
						} catch (error) {
							if (!abortController.signal.aborted) {
								log.error({ sessionId, err: error }, "session stream failed");
							}
						} finally {
							c.vars.sessionStreams.delete(sessionId);
						}
					})()
				);
			}

			await sandboxClient.postMessage(sessionId, {
				message: content,
			});

			await c.vars.db
				.update(sessions)
				.set({ status: "running", updatedAt: Date.now() })
				.where(eq(sessions.id, sessionId));

			await c.vars.db
				.update(tabs)
				.set({ updatedAt: Date.now() })
				.where(eq(tabs.id, createTabId("session", sessionId)));

			c.broadcast("tabs.changed");
		},

		replyPermission: async (
			c,
			sessionId: string,
			permissionId: string,
			reply: "once" | "always" | "reject"
		) => {
			if (!c.vars.sandboxClient) {
				if (!c.state.sandboxUrl) {
					throw new Error("Sandbox is not ready for session operations");
				}
				c.vars.sandboxClient = await SandboxAgentClient.connect({
					baseUrl: c.state.sandboxUrl,
				});
			}
			const sandboxClient = c.vars.sandboxClient;
			if (!sandboxClient) {
				throw new Error("Sandbox is not ready for session operations");
			}

			await sandboxClient.replyPermission(sessionId, permissionId, {
				reply,
			});
		},

		getTranscript: async (
			c,
			sessionId: string,
			offset: number,
			limit = 500
		) => {
			const rows = await c.vars.db
				.select({ eventJson: sessionEvents.eventJson })
				.from(sessionEvents)
				.where(
					and(
						eq(sessionEvents.sessionId, sessionId),
						gt(sessionEvents.sequence, offset)
					)
				)
				.orderBy(asc(sessionEvents.sequence))
				.limit(limit);

			return rows.map((row) => JSON.parse(row.eventJson) as UniversalEvent);
		},

		getScrollback: async (c, terminalId: string) => {
			const inMemory = c.vars.terminalBuffers.get(terminalId);
			if (inMemory) {
				return inMemory;
			}

			const rows = await c.vars.db
				.select({ scrollbackBlob: terminals.scrollbackBlob })
				.from(terminals)
				.where(eq(terminals.id, terminalId))
				.limit(1);

			const bytes = decodeBytes(rows[0]?.scrollbackBlob ?? null);
			c.vars.terminalBuffers.set(terminalId, bytes);
			return bytes;
		},

		input: async (c, terminalId: string, data: number[]) => {
			const handle = c.vars.terminalHandles.get(terminalId);
			if (!handle) {
				throw new Error(
					"Terminal handle is not available, call ensureTerminal first"
				);
			}

			await handle.sendInput(new Uint8Array(data));
		},

		resize: async (c, terminalId: string, cols: number, rows: number) => {
			await c.vars.db
				.update(terminals)
				.set({ cols, rows, updatedAt: Date.now() })
				.where(eq(terminals.id, terminalId));

			const handle = c.vars.terminalHandles.get(terminalId);
			if (!handle) {
				throw new Error(
					"Terminal handle is not available, call ensureTerminal first"
				);
			}

			await handle.resize(cols, rows);
		},

		archiveTab: async (c, tabId: string) => {
			await c.vars.db
				.update(tabs)
				.set({ archivedAt: Date.now(), updatedAt: Date.now() })
				.where(eq(tabs.id, tabId));
			c.broadcast("tabs.changed");
		},
	},
});
