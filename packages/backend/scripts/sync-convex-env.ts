import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// biome-ignore lint/style/noNonNullAssertion: dirname is always defined when running as a script
const BACKEND_DIR = resolve(import.meta.dirname!, "..");
const envConvexPath = resolve(BACKEND_DIR, ".env.convex");

if (!existsSync(envConvexPath)) {
	console.log("No .env.convex found, skipping Convex env sync.");
	process.exit(0);
}

const content = readFileSync(envConvexPath, "utf-8");

const conductorPort = process.env.CONDUCTOR_PORT
	? Number(process.env.CONDUCTOR_PORT)
	: undefined;
const envOverrides: Record<string, string> = {};
if (conductorPort) {
	envOverrides.WEB_URL = `http://localhost:${conductorPort}`;
}

for (const line of content.split("\n")) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) {
		continue;
	}
	const eqIndex = trimmed.indexOf("=");
	if (eqIndex === -1) {
		continue;
	}
	const key = trimmed.slice(0, eqIndex).trim();
	const value = envOverrides[key] ?? trimmed.slice(eqIndex + 1).trim();
	if (!value) {
		continue;
	}

	console.log(`Setting Convex env: ${key}`);
	execSync(`bunx convex env set ${key} '${value}'`, {
		cwd: BACKEND_DIR,
		stdio: "inherit",
	});
}

console.log("Convex env sync complete.");
