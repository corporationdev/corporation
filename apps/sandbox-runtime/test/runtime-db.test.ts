import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeDatabase } from "../db";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
	);
});

describe("openRuntimeDatabase", () => {
	test("creates the sqlite database and applies Drizzle migrations", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sandbox-runtime-db-"));
		tempDirs.push(tempDir);

		const handle = await openRuntimeDatabase({
			path: join(tempDir, "runtime.sqlite"),
		});

		try {
			const tables = handle.client
				.query(
					"select name from sqlite_master where type = 'table' order by name"
				)
				.all() as Array<{ name: string }>;

			expect(tables.map((table) => table.name)).toEqual(
				expect.arrayContaining([
					"__drizzle_migrations",
					"runtime_command_receipts",
					"runtime_event_log",
				])
			);
		} finally {
			handle.close();
		}
	});
});
