// Build the E2B base template with the minimal runtime/tooling needed for
// sandbox-runtime, terminal sessions, repo cloning, and computer-use flows.
//
// Usage:
//   bun scripts/build-base-template.ts
//
// Reads E2B_API_KEY from apps/server/.env automatically.

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

const installCommands = Array.from(
	new Set(
		acpAgents.flatMap((agent) =>
			[agent.nativeInstallCommand, agent.acpInstallCommand].filter(
				(command): command is string => typeof command === "string"
			)
		)
	)
);

let template = Template({ fileContextPath: repoRoot })
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
		"PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers bunx playwright install --with-deps chromium"
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
	template = template.runCmd(`${USER_PATH_EXPORT}\n${command}`);
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
