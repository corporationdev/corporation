#!/usr/bin/env bun

import {
	getSandboxRuntimePackageName,
	packSandboxRuntimePackage,
} from "./lib/sandbox-runtime-package";

const result = await packSandboxRuntimePackage();

console.log(
	JSON.stringify(
		{
			name: getSandboxRuntimePackageName(),
			version: result.version,
			stagingDir: result.stagingDir,
			tarballPath: result.tarballPath,
		},
		null,
		2
	)
);
