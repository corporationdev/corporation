import type { CachedEventRecord } from "@corporation/app/cache-adapter";
import { ipcMain } from "electron";
import { getDb } from "./db/index";
import { migrate } from "./db/migrate";
import { appendManyEvents, getEventsForSession } from "./db/operations";

export function registerIpcHandlers(): void {
	const db = getDb();
	migrate(db);

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
