#!/usr/bin/env bun

import process from "node:process";
import { packSandboxRuntimePackage } from "./lib/sandbox-runtime-package";

const argv = process.argv.slice(2);
const access = argv.includes("--public") ? "public" : "restricted";
const tagIndex = argv.indexOf("--tag");
const tag = tagIndex >= 0 ? argv[tagIndex + 1] : undefined;
const passthroughArgs = argv.filter((arg, index) => {
	if (arg === "--public" || arg === "--tag") {
		return false;
	}
	if (tagIndex >= 0 && index === tagIndex + 1) {
		return false;
	}
	return true;
});

if (tagIndex >= 0 && !tag) {
	throw new Error("Missing npm tag value after --tag");
}

const result = await packSandboxRuntimePackage();

const publishArgs = ["npm", "publish", "--access", access, ...passthroughArgs];
if (tag) {
	publishArgs.push("--tag", tag);
}

const publish = Bun.spawnSync(publishArgs, {
	cwd: result.stagingDir,
	stdout: "inherit",
	stderr: "inherit",
	stdin: "inherit",
});

if (publish.exitCode !== 0) {
	process.exit(publish.exitCode ?? 1);
}
