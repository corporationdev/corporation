import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { schema } from "./schema";

const DEFAULT_RUNTIME_DATABASE_PATH = join(
	homedir(),
	".tendril",
	"sandbox-runtime",
	"runtime.sqlite"
);

function getMigrationsFolderCandidates(): string[] {
	return [
		join(import.meta.dir, "migrations"),
		join(import.meta.dir, "..", "db", "migrations"),
		join(import.meta.dir, "db", "migrations"),
	];
}

export type RuntimeDatabase = BunSQLiteDatabase<typeof schema>;

export type RuntimeDatabaseHandle = {
	client: Database;
	db: RuntimeDatabase;
	path: string;
	close(): void;
};

export function getDefaultRuntimeDatabasePath(): string {
	const value = process.env.RUNTIME_DB_PATH?.trim();
	return value || DEFAULT_RUNTIME_DATABASE_PATH;
}

export function getRuntimeMigrationsFolder(): string {
	for (const candidate of getMigrationsFolderCandidates()) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error(
		`Could not find sandbox-runtime Drizzle migrations. Checked: ${getMigrationsFolderCandidates().join(", ")}`
	);
}

export async function openRuntimeDatabase(input?: {
	path?: string;
}): Promise<RuntimeDatabaseHandle> {
	const path = input?.path?.trim() || getDefaultRuntimeDatabasePath();
	await mkdir(dirname(path), { recursive: true });

	const client = new Database(path, {
		create: true,
		readwrite: true,
	});
	client.exec("PRAGMA foreign_keys = ON;");
	client.exec("PRAGMA journal_mode = WAL;");

	const db = drizzle(client, { schema });
	migrate(db, {
		migrationsFolder: getRuntimeMigrationsFolder(),
	});

	return {
		client,
		db,
		path,
		close() {
			client.close();
		},
	};
}
