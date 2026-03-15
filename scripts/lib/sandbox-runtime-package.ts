import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const runtimeSourceDir = resolve(repoRoot, "packages/cli");
const runtimeSourcePackageJsonPath = resolve(runtimeSourceDir, "package.json");
const runtimeEntrypointPath = resolve(runtimeSourceDir, "index.ts");
const stagingDir = resolve(runtimeSourceDir, "dist/npm-package");
const packageName = "@tendril/cli";

type BuildSandboxRuntimePackageOptions = {
	version?: string;
};

type SandboxRuntimeSourcePackage = {
	version: string;
	dependencies?: Record<string, string>;
};

export function getSandboxRuntimeSourceDir() {
	return runtimeSourceDir;
}

export function getSandboxRuntimePackageName() {
	return packageName;
}

export function getSandboxRuntimeStagingDir() {
	return stagingDir;
}

export async function readSandboxRuntimeVersion() {
	const sourcePackage = (await Bun.file(
		runtimeSourcePackageJsonPath
	).json()) as SandboxRuntimeSourcePackage;
	const version = sourcePackage.version?.trim();
	if (!version) {
		throw new Error(
			`Missing version in ${basename(runtimeSourcePackageJsonPath)}`
		);
	}
	return version;
}

async function readSandboxRuntimeSourcePackage() {
	return (await Bun.file(
		runtimeSourcePackageJsonPath
	).json()) as SandboxRuntimeSourcePackage;
}

function buildBinScript() {
	return `#!/usr/bin/env sh
set -eu
SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
	SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
	LINK_TARGET="$(readlink -- "$SCRIPT_PATH")"
	case "$LINK_TARGET" in
		/*) SCRIPT_PATH="$LINK_TARGET" ;;
		*) SCRIPT_PATH="$SCRIPT_DIR/$LINK_TARGET" ;;
	esac
done
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
PACKAGE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
exec bun "$PACKAGE_DIR/dist/index.js" "$@"
`;
}

function buildPackageReadme(version: string) {
	return `# @tendril/cli

Generated package artifact for Tendril sandbox runtime.

- Package: \`${packageName}\`
- Version: \`${version}\`

This package is built from \`packages/cli\` in the monorepo and is intended to run inside E2B sandboxes via the \`sandbox-runtime\` CLI bin.
`;
}

export async function buildSandboxRuntimePackage(
	options: BuildSandboxRuntimePackageOptions = {}
) {
	const sourcePackage = await readSandboxRuntimeSourcePackage();
	const version = options.version ?? sourcePackage.version?.trim();
	if (!version) {
		throw new Error(
			`Missing version in ${basename(runtimeSourcePackageJsonPath)}`
		);
	}
	const publishedDependencies = Object.fromEntries(
		Object.entries(sourcePackage.dependencies ?? {}).filter(
			([name]) => name === "playwright"
		)
	);

	await rm(stagingDir, { recursive: true, force: true });
	await mkdir(resolve(stagingDir, "dist"), { recursive: true });
	await mkdir(resolve(stagingDir, "dist/db"), { recursive: true });
	await mkdir(resolve(stagingDir, "bin"), { recursive: true });

	const build = Bun.spawnSync(
		[
			"bun",
			"build",
			runtimeEntrypointPath,
			"--outdir",
			resolve(stagingDir, "dist"),
			"--target=bun",
			"--external",
			"playwright",
			"--external",
			"playwright-core",
		],
		{
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		}
	);
	if (build.exitCode !== 0) {
		throw new Error(
			build.stderr.toString().trim() || "sandbox-runtime build failed"
		);
	}
	const distArtifacts = await readdir(resolve(stagingDir, "dist"));
	if (!distArtifacts.includes("index.js")) {
		throw new Error("sandbox-runtime build did not produce dist/index.js");
	}
	await cp(
		resolve(runtimeSourceDir, "db/migrations"),
		resolve(stagingDir, "dist/db/migrations"),
		{ recursive: true }
	);

	await writeFile(
		resolve(stagingDir, "bin/sandbox-runtime"),
		buildBinScript(),
		{
			encoding: "utf8",
		}
	);
	await chmod(resolve(stagingDir, "bin/sandbox-runtime"), 0o755);

	await writeFile(
		resolve(stagingDir, "package.json"),
		JSON.stringify(
			{
				name: packageName,
				version,
				private: false,
				type: "module",
				description: "Tendril sandbox runtime",
				bin: {
					"sandbox-runtime": "./bin/sandbox-runtime",
				},
				dependencies: publishedDependencies,
				files: ["bin", "dist", "README.md"],
			},
			null,
			2
		),
		{ encoding: "utf8" }
	);
	await writeFile(
		resolve(stagingDir, "README.md"),
		buildPackageReadme(version),
		{
			encoding: "utf8",
		}
	);
	await cp(
		runtimeSourcePackageJsonPath,
		resolve(stagingDir, "source-package.json")
	);

	return {
		version,
		stagingDir,
		entrypointPath: resolve(stagingDir, "dist/index.js"),
		binPath: resolve(stagingDir, "bin/sandbox-runtime"),
		packageJsonPath: resolve(stagingDir, "package.json"),
	};
}

export async function packSandboxRuntimePackage(
	options: BuildSandboxRuntimePackageOptions = {}
) {
	const buildResult = await buildSandboxRuntimePackage(options);

	const pack = Bun.spawnSync(["npm", "pack", "--json"], {
		cwd: buildResult.stagingDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (pack.exitCode !== 0) {
		throw new Error(
			pack.stderr.toString().trim() || "npm pack for sandbox-runtime failed"
		);
	}

	const parsed = JSON.parse(pack.stdout.toString().trim()) as Array<{
		filename: string;
	}>;
	const filename = parsed[0]?.filename;
	if (!filename) {
		throw new Error("npm pack did not return a filename");
	}

	return {
		...buildResult,
		tarballPath: resolve(buildResult.stagingDir, filename),
	};
}
