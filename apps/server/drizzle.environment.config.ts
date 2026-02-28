import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/environment/db/schema.ts",
	out: "./src/environment/db/migrations",
	dialect: "sqlite",
	driver: "durable-sqlite",
	strict: true,
	verbose: true,
});
