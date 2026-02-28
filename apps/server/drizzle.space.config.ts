import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/space/db/schema.ts",
	out: "./src/space/db/migrations",
	dialect: "sqlite",
	driver: "durable-sqlite",
	strict: true,
	verbose: true,
});
