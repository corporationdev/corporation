import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const envLineRegex = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)/;

const repoRoot = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);

const useSandbox = argv.includes("--sandbox");
const sync = argv.includes("--sync");
const reseed = argv.includes("--reseed");
const mode = useSandbox ? "--sandbox" : "--dev";

console.log(`Running setup (mode: ${mode})`);

await $`bun install`.cwd(repoRoot);
await $`bun secrets:inject ${mode}`.cwd(repoRoot);

if (useSandbox) {
	const localDb = resolve(
		repoRoot,
		"packages/backend/.convex/local/default/convex_local_backend.sqlite3"
	);

	if (!reseed && existsSync(localDb)) {
		console.log(
			"Local database already exists, skipping seed (use --reseed to force)"
		);
	} else {
		console.log("Seeding local Convex from dev deployment...");
		const seedZip = `/tmp/convex-seed-${process.pid}.zip`;
		try {
			await $`bunx convex export --path ${seedZip}`
				.env(loadBackendEnv())
				.cwd(repoRoot);
			await $`zip -d ${seedZip} '_components/betterAuth/jwks/*' '_components/betterAuth/session/*'`
				.cwd(repoRoot)
				.nothrow();
			await $`bunx convex dev --local --once --run-sh ${`bunx convex import ${seedZip} --replace --yes`}`
				.env(loadBackendEnv())
				.cwd(resolve(repoRoot, "packages/backend"));
		} catch {
			console.log(
				"[seed] Seed failed (non-fatal), continuing with empty database"
			);
		} finally {
			await $`rm -f ${seedZip}`.nothrow();
		}
	}
}

if (sync) {
	console.log("Syncing environment variables to Convex...");
	const backendDir = resolve(repoRoot, "packages/backend");
	if (useSandbox) {
		await $`CONVEX_AGENT_MODE=anonymous bunx convex dev --local --once --run-sh ${"bun ./sync-convex-env.ts"}`
			.env(loadBackendEnv())
			.cwd(backendDir);
	} else {
		await $`bunx convex dev --once --run-sh ${"bun ./sync-convex-env.ts"}`
			.env(loadBackendEnv())
			.cwd(backendDir);
	}
}

function loadBackendEnv() {
	const envPath = resolve(repoRoot, "packages/backend/.env");
	const text = readFileSync(envPath, "utf8");
	const env: Record<string, string> = { ...process.env } as Record<
		string,
		string
	>;
	for (const line of text.split("\n")) {
		const match = line.match(envLineRegex);
		if (match) {
			env[match[1]] = match[2];
		}
	}
	return env;
}
