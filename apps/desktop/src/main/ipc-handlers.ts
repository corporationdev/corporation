import { ipcMain } from "electron";
import type { AgentSessionRecord, CachedEventRecord } from "../shared/ipc-api";
import { getDb } from "./db/index";
import { migrate } from "./db/migrate";
import {
	appendManyEvents,
	getAllSessions,
	getEventsForSession,
	replaceAllSessions,
} from "./db/operations";

export function registerIpcHandlers(): void {
	const db = getDb();
	migrate(db);

	ipcMain.handle("cache:sessions:getAll", () => getAllSessions(db));
	ipcMain.handle(
		"cache:sessions:replaceAll",
		(_, sessions: AgentSessionRecord[]) => {
			replaceAllSessions(db, sessions);
		}
	);

	ipcMain.handle("cache:events:getForSession", (_, sessionId: string) =>
		getEventsForSession(db, sessionId)
	);
	ipcMain.handle(
		"cache:events:appendMany",
		(_, events: CachedEventRecord[]) => {
			appendManyEvents(db, events);
		}
	);
}
