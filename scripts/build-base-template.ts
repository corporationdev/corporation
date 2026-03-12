// Build the E2B base template with the minimal runtime/tooling needed for
// sandbox-runtime, terminal sessions, repo cloning, and computer-use flows.
//
// Usage:
//   bun scripts/build-base-template.ts
//
// Reads E2B_API_KEY from apps/server/.env automatically.

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import acpAgents from "@corporation/config/acp-agent-manifest";
import { config } from "dotenv";
import { defaultBuildLogger, Template } from "e2b";

const repoRoot = resolve(import.meta.dirname, "..");

config({ path: resolve(repoRoot, "apps/server/.env") });

const SANDBOX_USER = "user";
const SANDBOX_WORKDIR = "/workspace";
const USER_PATH_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"';

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

const installCommands = Array.from(
	new Set(
		acpAgents.flatMap((agent) =>
			[agent.nativeInstallCommand, agent.acpInstallCommand].filter(
				(command): command is string => typeof command === "string"
			)
		)
	)
);

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
		"unzip",
		"imagemagick",
		"python3-venv",
	])
	.runCmd(
		"export BUN_INSTALL=/usr/local && curl -fsSL https://bun.sh/install | bash && (test -x /usr/local/bin/bunx || ln -sf /usr/local/bin/bun /usr/local/bin/bunx)"
	)
	.runCmd(
		"curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh"
	)
	.runCmd(
		"python3 -m venv /opt/mitmproxy && /opt/mitmproxy/bin/pip install --upgrade pip && /opt/mitmproxy/bin/pip install mitmproxy && ln -sf /opt/mitmproxy/bin/mitmdump /usr/local/bin/mitmdump"
	)
	.runCmd(
		`mkdir -p ${SANDBOX_WORKDIR} && chown ${SANDBOX_USER}:${SANDBOX_USER} ${SANDBOX_WORKDIR}`
	)
	.runCmd(
		`mkdir -p /home/${SANDBOX_USER}/.local/bin /home/${SANDBOX_USER}/.local/share/corporation && chown -R ${SANDBOX_USER}:${SANDBOX_USER} /home/${SANDBOX_USER}/.local`
	)
	// Install sandbox-runtime JS bundle
	.copy(
		"apps/sandbox-runtime/dist/sandbox-runtime.js",
		"/usr/local/bin/sandbox-runtime.js"
	)
	.setUser(SANDBOX_USER)
	.setWorkdir(SANDBOX_WORKDIR)
	.runCmd(
		[
			'touch "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc"',
			`grep -qxF '${USER_PATH_EXPORT}' "$HOME/.bashrc" || printf '\\n${USER_PATH_EXPORT}\\n' >> "$HOME/.bashrc"`,
			`grep -qxF '${USER_PATH_EXPORT}' "$HOME/.profile" || printf '\\n${USER_PATH_EXPORT}\\n' >> "$HOME/.profile"`,
			`grep -qxF '${USER_PATH_EXPORT}' "$HOME/.zshrc" || printf '\\n${USER_PATH_EXPORT}\\n' >> "$HOME/.zshrc"`,
		].join(" && ")
	);

for (const command of installCommands) {
	template.runCmd(`${USER_PATH_EXPORT}\n${command}`);
}

console.log("Building base template…");

const result = await Template.build(template, "corporation-base", {
	apiKey,
	onBuildLogs: defaultBuildLogger(),
});

console.log("\nTemplate built successfully!");
console.log("Template ID:", result.templateId);
console.log("Alias:      ", "corporation-base");
console.log(
	"\nSet E2B_BASE_TEMPLATE_ID in your environment to use this template for snapshot builds."
);
