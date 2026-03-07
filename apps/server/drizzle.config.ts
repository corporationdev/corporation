import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/space-do/db/schema.ts",
	out: "./src/space-do/db/migrations",
	dialect: "sqlite",
	driver: "durable-sqlite",
	strict: true,
	verbose: true,
});
