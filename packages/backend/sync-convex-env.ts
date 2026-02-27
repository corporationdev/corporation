import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRuntimeContext } from "@corporation/config/runtime";
import { parse as parseDotEnv } from "dotenv";

const envFilePath = resolve(import.meta.dirname, ".env");
const exampleEnvPath = resolve(import.meta.dirname, ".env.example");

// Local: read values from .env. CI: read keys from .env.example, values from process.env.
const source = existsSync(envFilePath) ? envFilePath : exampleEnvPath;
const keys = Object.keys(parseDotEnv(readFileSync(source, "utf8")));
const secretsEnv: Record<string, string> = {};
for (const key of keys) {
	const value = process.env[key];
	if (value) {
		secretsEnv[key] = value;
	}
}

const stage = (secretsEnv.STAGE ?? process.env.STAGE)?.trim();
if (!stage) {
	throw new Error(
		"Missing STAGE for convex env sync. Run `bun secrets:inject` first."
	);
}
const runtime = resolveRuntimeContext(stage);

const mergedEnv = {
	...secretsEnv,
	STAGE: stage,
	...runtime.convexSyncEnv,
};

for (const [key, value] of Object.entries(mergedEnv)) {
	if (!value) {
		continue;
	}

	console.log(`Setting ${key}`);
	const result = spawnSync("bunx", ["convex", "env", "set", key, value], {
		cwd: import.meta.dirname,
		stdio: "inherit",
	});
	if (result.status !== 0) {
		console.error(`Failed to set ${key}. Continuing.`);
	}
}
