import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRuntimeContext } from "@tendril/config/runtime";
import { getStageKind } from "@tendril/config/stage";
import { parse as parseDotEnv } from "dotenv";

const envFilePath = resolve(import.meta.dirname, ".env");
const exampleEnvPath = resolve(import.meta.dirname, ".env.example");

// Sync only documented backend secrets. Local values may come from .env; CI uses process.env.
const localEnv = existsSync(envFilePath)
	? parseDotEnv(readFileSync(envFilePath, "utf8"))
	: {};
const keys = Object.keys(parseDotEnv(readFileSync(exampleEnvPath, "utf8")));
const secretsEnv: Record<string, string> = {};
for (const key of keys) {
	const value = process.env[key] ?? localEnv[key];
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
const stageKind = getStageKind(stage);

// Build deployment target flags for the Convex CLI.
// Preview deployments require --preview-name, production requires --prod.
const deploymentFlags: string[] = [];
if (stageKind === "preview") {
	deploymentFlags.push("--preview-name", stage);
} else if (stageKind === "production") {
	deploymentFlags.push("--prod");
}

const mergedEnv = {
	...secretsEnv,
	STAGE: stage,
	...runtime.convexSyncEnv,
};

let failedSetCount = 0;
for (const [key, value] of Object.entries(mergedEnv)) {
	if (!value) {
		continue;
	}

	console.log(`Setting ${key}`);
	const result = spawnSync(
		"bunx",
		["convex", "env", "set", ...deploymentFlags, key, value],
		{
			cwd: import.meta.dirname,
			stdio: "inherit",
		}
	);
	if (result.status !== 0) {
		console.error(`Failed to set ${key}. Continuing.`);
		failedSetCount += 1;
	}
}

if (failedSetCount > 0) {
	throw new Error(
		`Failed to sync ${failedSetCount} environment variable${failedSetCount === 1 ? "" : "s"} to Convex.`
	);
}
