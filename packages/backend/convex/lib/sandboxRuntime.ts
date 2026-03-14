"use node";

import type { Sandbox } from "e2b";
import { quoteShellArg } from "./git";
import { runRootCommand } from "./sandbox";

export const SANDBOX_RUNTIME_PACKAGE_NAME = "@isaacdyor/sandbox-runtime";
export const SANDBOX_RUNTIME_INSTALL_ROOT = "/opt/tendril/sandbox-runtime";
export const SANDBOX_RUNTIME_ACTIVE_BIN = "/usr/local/bin/sandbox-runtime";
export const SANDBOX_RUNTIME_VERSION = "1.0.1";

function getSandboxRuntimeVersion() {
	return SANDBOX_RUNTIME_VERSION;
}

export function getSandboxRuntimeInstallPrefix(version: string) {
	return `${SANDBOX_RUNTIME_INSTALL_ROOT}/${version}`;
}

export function getSandboxRuntimeVersionedBinPath(version: string) {
	return `${getSandboxRuntimeInstallPrefix(version)}/bin/sandbox-runtime`;
}

function createInstallCommand(input: { packageSpec: string; prefix: string }) {
	return `mkdir -p ${quoteShellArg(input.prefix)} && npm install -g --prefix ${quoteShellArg(input.prefix)} ${quoteShellArg(input.packageSpec)}`;
}

async function isExecutable(sandbox: Sandbox, path: string) {
	try {
		await runRootCommand(sandbox, `test -x ${quoteShellArg(path)}`);
		return true;
	} catch {
		return false;
	}
}

export async function ensureSandboxRuntimeInstalled(sandbox: Sandbox) {
	const version = getSandboxRuntimeVersion();
	const prefix = getSandboxRuntimeInstallPrefix(version);
	const versionedBin = getSandboxRuntimeVersionedBinPath(version);

	const startedAt = Date.now();
	const alreadyInstalled = await isExecutable(sandbox, versionedBin);
	if (!alreadyInstalled) {
		console.log("sandbox_runtime_install_start", {
			version,
			packageName: SANDBOX_RUNTIME_PACKAGE_NAME,
			sandboxId: sandbox.sandboxId,
		});
		try {
			await runRootCommand(
				sandbox,
				createInstallCommand({
					packageSpec: `${SANDBOX_RUNTIME_PACKAGE_NAME}@${version}`,
					prefix,
				}),
				{ cwd: "/" }
			);
		} catch (error) {
			console.error("sandbox_runtime_install_failure", {
				version,
				packageName: SANDBOX_RUNTIME_PACKAGE_NAME,
				sandboxId: sandbox.sandboxId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	await runRootCommand(
		sandbox,
		`mkdir -p /usr/local/bin && ln -sf ${quoteShellArg(versionedBin)} ${quoteShellArg(SANDBOX_RUNTIME_ACTIVE_BIN)}`
	);
	await runRootCommand(
		sandbox,
		`test -x ${quoteShellArg(SANDBOX_RUNTIME_ACTIVE_BIN)}`
	);

	console.log("sandbox_runtime_install_ready", {
		version,
		packageName: SANDBOX_RUNTIME_PACKAGE_NAME,
		sandboxId: sandbox.sandboxId,
		installed: !alreadyInstalled,
		durationMs: Date.now() - startedAt,
		activeBin: SANDBOX_RUNTIME_ACTIVE_BIN,
	});

	return {
		version,
		command: SANDBOX_RUNTIME_ACTIVE_BIN,
	};
}
