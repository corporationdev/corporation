// Build the E2B base template with Node 22, common package managers,
// corp-agent, and preinstalled coding agents.
//
// Usage:
//   bun scripts/build-base-template.ts
//
// Prerequisites:
//   bun run build:corp-agent   (compiles scripts/corp-agent/dist/corp-agent)
//
// Reads E2B_API_KEY from apps/server/.env automatically.

import { resolve } from "node:path";
import { config } from "dotenv";
import { defaultBuildLogger, Template } from "e2b";

config({ path: resolve(import.meta.dirname, "../apps/server/.env") });

const TEMPLATE_CPU_COUNT = 4;
const TEMPLATE_MEMORY_MB = 8192;

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) {
	throw new Error(
		"Missing E2B_API_KEY — make sure apps/server/.env contains it"
	);
}

const template = Template()
	.fromTemplate("desktop")
	.setUser("root")
	// Install Node.js 22 (desktop template doesn't include it)
	.runCmd(
		"curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
	)
	.aptInstall(["ca-certificates", "git", "zip", "unzip", "zsh", "curl", "tmux"])
	// TODO: move cloudflared to dynamic installation once we add that capability
	.runCmd(
		'set -euo pipefail; ARCH=$(dpkg --print-architecture); curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb" -o /tmp/cloudflared.deb; dpkg -i /tmp/cloudflared.deb; rm -f /tmp/cloudflared.deb; cloudflared --version'
	)
	.runCmd(
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable interpolation, not JS templates
		'set -euo pipefail; OP_VERSION=2.31.0; ARCH=$(dpkg --print-architecture); case "$ARCH" in amd64) OP_ARCH=amd64 ;; arm64) OP_ARCH=arm64 ;; *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; esac; curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${OP_ARCH}_v${OP_VERSION}.zip" -o /tmp/op.zip; unzip -q /tmp/op.zip -d /tmp; install -m 0755 /tmp/op /usr/local/bin/op; rm -f /tmp/op /tmp/op.zip; op --version'
	)
	.runCmd("npm install -g --force yarn pnpm")
	.runCmd(
		"curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx"
	)
	// Install corp-agent binary
	.copy("corp-agent/dist/corp-agent", "/usr/local/bin/corp-agent")
	.runCmd("chmod +x /usr/local/bin/corp-agent")
	// Pre-cache ACP agent npm packages so npx doesn't download at runtime
	.runCmd(
		"set -euo pipefail; npm install -g @zed-industries/claude-code-acp @zed-industries/codex-acp pi-acp @blowmage/cursor-agent-acp"
	)
	// Install opencode native binary
	.runCmd(
		'set -euo pipefail; curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v1.2.20/opencode-linux-x64.tar.gz" -o /tmp/opencode.tar.gz; tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode; chmod +x /usr/local/bin/opencode; rm -f /tmp/opencode.tar.gz; opencode --version'
	)
	// Install amp-acp native binary
	.runCmd(
		'set -euo pipefail; curl -fsSL "https://github.com/tao12345666333/amp-acp/releases/download/v0.7.0/amp-acp-linux-x86_64.tar.gz" -o /tmp/amp-acp.tar.gz; tar -xzf /tmp/amp-acp.tar.gz -C /usr/local/bin amp-acp; chmod +x /usr/local/bin/amp-acp; rm -f /tmp/amp-acp.tar.gz'
	);

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
