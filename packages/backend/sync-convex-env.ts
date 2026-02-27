import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRuntimeContext } from "@corporation/config/runtime";
import { parse as parseDotEnv } from "dotenv";

const envFilePath = resolve(import.meta.dirname, ".env");
const fileEnv = existsSync(envFilePath)
	? parseDotEnv(readFileSync(envFilePath, "utf8"))
	: {};
const stage = (fileEnv.STAGE ?? process.env.STAGE)?.trim();
if (!stage) {
	throw new Error(
		"Missing STAGE for convex env sync. Run `bun secrets:inject` first."
	);
}
const runtime = resolveRuntimeContext(stage);

const mergedEnv = {
	...fileEnv,
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
