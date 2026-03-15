import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./agent-runtime/db/schema.ts",
	out: "./db/migrations",
	dialect: "sqlite",
	dbCredentials: {
		url: "./.drizzle/sandbox-runtime.sqlite",
	},
	strict: true,
	verbose: true,
});
