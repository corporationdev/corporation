import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./db/schema.ts",
	out: "./db/migrations",
	dialect: "sqlite",
	dbCredentials: {
		url: "./.drizzle/sandbox-runtime.sqlite",
	},
	strict: true,
	verbose: true,
});
