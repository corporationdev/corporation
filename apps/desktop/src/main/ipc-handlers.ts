import { ipcMain } from "electron";

import type { AgentSession, CachedEvent } from "../shared/ipc-api";
import { getDb } from "./db/index";
import { migrate } from "./db/migrate";
import {
	appendManyEvents,
	deleteEventsForSession,
	getAllSessions,
	getEventsForSession,
	getSessionById,
	replaceAllSessions,
	upsertSession,
} from "./db/operations";

export function registerIpcHandlers() {
	const db = getDb();
	migrate(db);

	// --- Sync reads (ipcMain.on + event.returnValue) ---

	ipcMain.on("cache:sessions:getAll", (event) => {
		event.returnValue = getAllSessions(db);
	});

	ipcMain.on("cache:sessions:getById", (event, id: string) => {
		event.returnValue = getSessionById(db, id);
	});

	ipcMain.on("cache:events:getForSession", (event, sessionId: string) => {
		event.returnValue = getEventsForSession(db, sessionId);
	});

	// --- Async writes (ipcMain.handle) ---

	ipcMain.handle("cache:sessions:replaceAll", (_, sessions: AgentSession[]) => {
		replaceAllSessions(db, sessions);
	});

	ipcMain.handle("cache:sessions:upsert", (_, session: AgentSession) => {
		upsertSession(db, session);
	});

	ipcMain.handle("cache:events:appendMany", (_, events: CachedEvent[]) => {
		appendManyEvents(db, events);
	});

	ipcMain.handle("cache:events:deleteForSession", (_, sessionId: string) => {
		deleteEventsForSession(db, sessionId);
	});
}
