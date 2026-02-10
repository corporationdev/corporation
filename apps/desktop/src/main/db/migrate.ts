import { existsSync } from "node:fs";
import path from "node:path";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { app } from "electron";
import type { AppDb } from "./index";

function resolveMigrationsFolder(): string {
	const migrationsFolder = path.resolve(app.getAppPath(), "drizzle");
	const journalPath = path.join(migrationsFolder, "meta/_journal.json");

	if (existsSync(journalPath)) {
		return migrationsFolder;
	}

	throw new Error(
		`Drizzle migrations not found at ${migrationsFolder}. Run \`bun desktop:generate\` first.`
	);
}

export function migrate(db: AppDb): void {
	drizzleMigrate(db.orm, { migrationsFolder: resolveMigrationsFolder() });
}
