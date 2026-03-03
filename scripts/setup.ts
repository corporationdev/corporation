import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const envLineRegex = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)/;
const DEV_DEPLOYMENT = "dev:hip-impala-208";
const DEV_DEPLOY_KEY_OP_REFERENCE = "op://corporation-dev/Convex/deploy-key";
const IGNORE_DEPLOY_KEY = "<ignore_deploy_key>";

const repoRoot = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const backendDir = resolve(repoRoot, "packages/backend");

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
			const backendEnv = loadBackendEnv();
			const localEnv = withIgnoredDeployKey(backendEnv);
			const seedExportEnv = {
				...localEnv,
				CONVEX_DEPLOYMENT: DEV_DEPLOYMENT,
			};
			const seedDeployKey = await readSeedDeployKeyFromOp();
			if (seedDeployKey) {
				seedExportEnv.CONVEX_DEPLOY_KEY = seedDeployKey;
			}
			await $`bunx convex export --path ${seedZip}`
				.env(seedExportEnv)
				.cwd(backendDir);
			await $`zip -d ${seedZip} '_components/betterAuth/jwks/*' '_components/betterAuth/session/*'`
				.cwd(repoRoot)
				.nothrow();
			await $`CONVEX_AGENT_MODE=anonymous bunx convex dev --local --once --run-sh ${`bunx convex import ${seedZip} --replace --yes`}`
				.env(localEnv)
				.cwd(backendDir);
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
	if (useSandbox) {
		const localEnv = withIgnoredDeployKey(loadBackendEnv());
		const directSync = await $`bun ./sync-convex-env.ts`
			.env(localEnv)
			.cwd(backendDir)
			.nothrow()
			.quiet();
		if (directSync.exitCode === 0) {
			console.log("Synced env vars to running local backend.");
		} else {
			await $`CONVEX_AGENT_MODE=anonymous bunx convex dev --local --once --run-sh ${"bun ./sync-convex-env.ts"}`
				.env(localEnv)
				.cwd(backendDir);
		}
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
		if (match?.[1]) {
			env[match[1]] = match[2] ?? "";
		}
	}
	return env;
}

function withIgnoredDeployKey(env: Record<string, string>) {
	return {
		...env,
		CONVEX_DEPLOY_KEY: IGNORE_DEPLOY_KEY,
	};
}

async function readSeedDeployKeyFromOp() {
	try {
		const key = (
			await $`op read ${DEV_DEPLOY_KEY_OP_REFERENCE}`.quiet().text()
		).trim();
		return key.length > 0 ? key : undefined;
	} catch {
		console.log(
			"[seed] Unable to read Convex deploy key from 1Password; using existing Convex auth"
		);
		return undefined;
	}
}
