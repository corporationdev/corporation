import { execSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

// biome-ignore lint/style/noNonNullAssertion: dirname is always defined when running as a script
const BACKEND_DIR = resolve(import.meta.dirname!, "..");
const ROOT_DIR = resolve(BACKEND_DIR, "../..");

const ENV_FILES = [
	"apps/desktop/.env",
	"apps/server/.env",
	"apps/web/.env",
	"packages/backend/.env.convex",
	"packages/infra/.env",
];

const CONVEX_URL_KEYS: Record<string, string[]> = {
	"apps/web/.env": ["VITE_CONVEX_URL", "VITE_CONVEX_SITE_URL"],
	"apps/desktop/.env": ["VITE_CONVEX_URL", "VITE_CONVEX_SITE_URL"],
	"apps/server/.env": ["CONVEX_URL", "CONVEX_SITE_URL"],
};

const WHITESPACE_RE = /\s+/;

function getMainWorktree(): string {
	const output = execSync("git worktree list", { encoding: "utf-8" });
	const firstLine = output.trim().split("\n")[0];
	if (!firstLine) {
		throw new Error("Could not determine main worktree");
	}
	const path = firstLine.split(WHITESPACE_RE)[0];
	if (!path) {
		throw new Error("Could not parse worktree path");
	}
	return path;
}

function parseEnvFile(content: string): Map<string, string> {
	const vars = new Map<string, string>();
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
		const value = trimmed.slice(eqIndex + 1).trim();
		vars.set(key, value);
	}
	return vars;
}

function writeEnvFile(path: string, vars: Map<string, string>): void {
	const lines: string[] = [];
	for (const [key, value] of vars) {
		lines.push(`${key}=${value}`);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`);
}

function patchEnvFile(
	filePath: string,
	overrides: Record<string, string>
): void {
	if (!existsSync(filePath)) {
		console.log(`Warning: ${filePath} not found, creating it`);
		const vars = new Map(Object.entries(overrides));
		writeEnvFile(filePath, vars);
		return;
	}

	const content = readFileSync(filePath, "utf-8");
	const vars = parseEnvFile(content);
	for (const [key, value] of Object.entries(overrides)) {
		vars.set(key, value);
	}
	writeEnvFile(filePath, vars);
}

// Step 1: Copy env files from main worktree
const mainWorktree = getMainWorktree();
const isMainWorktree = resolve(ROOT_DIR) === resolve(mainWorktree);

if (isMainWorktree) {
	console.log("Running in main worktree, skipping file copy.");
} else {
	console.log(`Copying env files from main worktree: ${mainWorktree}`);
	for (const file of ENV_FILES) {
		const src = resolve(mainWorktree, file);
		const dest = resolve(ROOT_DIR, file);
		if (existsSync(src)) {
			mkdirSync(dirname(dest), { recursive: true });
			cpSync(src, dest);
			console.log(`  Copied ${file}`);
		} else {
			console.log(`  Warning: ${src} not found, skipping`);
		}
	}

	// Copy alchemy state directory
	const alchemySrc = resolve(mainWorktree, "packages/infra/.alchemy");
	const alchemyDest = resolve(ROOT_DIR, "packages/infra/.alchemy");
	if (existsSync(alchemySrc)) {
		cpSync(alchemySrc, alchemyDest, { recursive: true });
		console.log("  Copied packages/infra/.alchemy/");
	}
}

// Step 2: Remove existing .env.local so anonymous mode starts fresh
const envLocalPath = resolve(BACKEND_DIR, ".env.local");
if (existsSync(envLocalPath)) {
	rmSync(envLocalPath);
	console.log("Removed existing .env.local");
}

// Step 3: Bootstrap anonymous local Convex deployment
console.log("\nBootstrapping local Convex deployment...");
execSync("bunx convex dev --local --once", {
	cwd: BACKEND_DIR,
	stdio: "inherit",
	env: {
		...process.env,
		CONVEX_AGENT_MODE: "anonymous",
	},
});

// Step 4: Read CONVEX_URL from generated .env.local and derive site URL
const envLocalContent = readFileSync(envLocalPath, "utf-8");
const envLocalVars = parseEnvFile(envLocalContent);

const convexUrl = envLocalVars.get("CONVEX_URL");
if (!convexUrl) {
	throw new Error("CONVEX_URL not found in .env.local after bootstrap");
}

const apiUrl = new URL(convexUrl);
const sitePort = Number(apiUrl.port) + 1;
const convexSiteUrl = `http://127.0.0.1:${sitePort}`;

console.log(`\nConvex API:  ${convexUrl}`);
console.log(`Convex Site: ${convexSiteUrl}`);

// Step 5: Patch downstream .env files with local Convex URLs
console.log("\nPatching .env files with local Convex URLs...");
for (const [relPath, keys] of Object.entries(CONVEX_URL_KEYS)) {
	const filePath = resolve(ROOT_DIR, relPath);
	const overrides: Record<string, string> = {};
	for (const key of keys) {
		overrides[key] = key.includes("SITE") ? convexSiteUrl : convexUrl;
	}
	patchEnvFile(filePath, overrides);
	console.log(`  Patched ${relPath}`);
}

// Step 6: Patch port-dependent URLs when running inside Conductor
const conductorPort = process.env.CONDUCTOR_PORT
	? Number(process.env.CONDUCTOR_PORT)
	: undefined;

if (conductorPort) {
	const serverPort = conductorPort + 1;
	const webUrl = `http://localhost:${conductorPort}`;
	const serverUrl = `http://localhost:${serverPort}`;
	console.log(`\nConductor detected (port ${conductorPort})`);
	console.log(`  Web:    ${webUrl}`);
	console.log(`  Server: ${serverUrl}`);

	patchEnvFile(resolve(ROOT_DIR, "apps/web/.env"), {
		VITE_SERVER_URL: serverUrl,
	});
	patchEnvFile(resolve(ROOT_DIR, "apps/desktop/.env"), {
		VITE_SERVER_URL: serverUrl,
	});
	patchEnvFile(resolve(ROOT_DIR, "packages/backend/.env.convex"), {
		WEB_URL: webUrl,
	});
	console.log("  Patched .env files with Conductor ports");
}

console.log("\nLocal Convex setup complete!");
console.log(
	"Run `bun run dev` to start the local backend (env vars will sync automatically)."
);
