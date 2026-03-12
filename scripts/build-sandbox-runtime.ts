#!/usr/bin/env bun

import {
	buildSandboxRuntimePackage,
	getSandboxRuntimePackageName,
} from "./lib/sandbox-runtime-package";

const result = await buildSandboxRuntimePackage();

console.log(
	JSON.stringify(
		{
			name: getSandboxRuntimePackageName(),
			version: result.version,
			stagingDir: result.stagingDir,
			entrypointPath: result.entrypointPath,
			binPath: result.binPath,
		},
		null,
		2
	)
);
