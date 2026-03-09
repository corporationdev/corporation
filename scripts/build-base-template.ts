// Build the E2B base template with the minimal runtime/tooling needed for
// sandbox-runtime, terminal sessions, repo cloning, and computer-use flows.
//
// Usage:
//   bun scripts/build-base-template.ts
//
// Reads E2B_API_KEY from apps/server/.env automatically.

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import { defaultBuildLogger, Template } from "e2b";

const repoRoot = resolve(import.meta.dirname, "..");

config({ path: resolve(repoRoot, "apps/server/.env") });

const TEMPLATE_CPU_COUNT = 4;
const TEMPLATE_MEMORY_MB = 8192;
const SANDBOX_USER = "user";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) {
	throw new Error(
		"Missing E2B_API_KEY — make sure apps/server/.env contains it"
	);
}

// Build sandbox-runtime JS bundle
console.log("Building sandbox-runtime…");
const sandboxRuntimeDir = resolve(repoRoot, "apps/sandbox-runtime");
const sandboxRuntimeBundlePath = resolve(
	sandboxRuntimeDir,
	"dist/sandbox-runtime.js"
);
await mkdir(resolve(sandboxRuntimeDir, "dist"), { recursive: true });
const build = Bun.spawnSync([
	"bun",
	"build",
	resolve(sandboxRuntimeDir, "src/index.ts"),
	"--outfile",
	sandboxRuntimeBundlePath,
	"--target=bun",
]);
if (build.exitCode !== 0) {
	throw new Error(
		`sandbox-runtime build failed: ${build.stderr.toString().trim()}`
	);
}
console.log("sandbox-runtime built.");

const template = Template({ fileContextPath: repoRoot })
	.fromTemplate("desktop")
	.setUser("root")
	// Install Node.js 22 (desktop template doesn't include it)
	.runCmd(
		"curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
	)
	.aptInstall([
		"ca-certificates",
		"git",
		"ripgrep",
		"curl",
		"tmux",
		"imagemagick",
	])
	.runCmd(
		"export BUN_INSTALL=/usr/local && curl -fsSL https://bun.sh/install | bash && (test -x /usr/local/bin/bunx || ln -sf /usr/local/bin/bun /usr/local/bin/bunx)"
	)
	.runCmd(
		"curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh"
	)
	// Install sandbox-runtime JS bundle
	.copy(
		"apps/sandbox-runtime/dist/sandbox-runtime.js",
		"/usr/local/bin/sandbox-runtime.js"
	)
	.setUser(SANDBOX_USER)
	.setWorkdir(`/home/${SANDBOX_USER}`);

console.log("Building base template…");

const result = await Template.build(template, "corporation-base", {
	apiKey,
	cpuCount: TEMPLATE_CPU_COUNT,
	memoryMB: TEMPLATE_MEMORY_MB,
	onBuildLogs: defaultBuildLogger(),
});

console.log("\nTemplate built successfully!");
console.log("Template ID:", result.templateId);
console.log("Alias:      ", "corporation-base");
console.log(
	"\nSet E2B_BASE_TEMPLATE_ID in your environment to use this template for snapshot builds."
);
