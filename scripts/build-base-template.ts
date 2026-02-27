// Build the E2B base template with Node 22, common package managers, and sandbox-agent.
//
// Usage:
//   bun scripts/build-base-template.ts
//
// Reads E2B_API_KEY from apps/server/.env automatically.

import { resolve } from "node:path";
import { config } from "dotenv";
import { defaultBuildLogger, Template } from "e2b";

config({ path: resolve(import.meta.dirname, "../apps/server/.env") });

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) {
	throw new Error(
		"Missing E2B_API_KEY — make sure apps/server/.env contains it"
	);
}

const template = Template()
	.fromNodeImage("22")
	.setUser("root")
	.aptInstall(["ca-certificates", "git", "unzip", "zsh", "curl"])
	.runCmd(
		"set -euo pipefail; OP_VERSION=2.31.0; ARCH=$(dpkg --print-architecture); case \"$ARCH\" in amd64) OP_ARCH=amd64 ;; arm64) OP_ARCH=arm64 ;; *) echo \"Unsupported architecture: $ARCH\" >&2; exit 1 ;; esac; curl -fsSL \"https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${OP_ARCH}_v${OP_VERSION}.zip\" -o /tmp/op.zip; unzip -q /tmp/op.zip -d /tmp; install -m 0755 /tmp/op /usr/local/bin/op; rm -f /tmp/op /tmp/op.zip; op --version"
	)
	.runCmd("npm install -g --force yarn pnpm")
	.runCmd(
		"curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx"
	)
	.runCmd(
		"curl -fsSL https://releases.rivet.dev/sandbox-agent/0.2.1/install.sh | sh"
	);

console.log("Building base template…");

const result = await Template.build(template, "corporation-base", {
	apiKey,
	memoryMB: 4096,
	onBuildLogs: defaultBuildLogger(),
});

console.log("\nTemplate built successfully!");
console.log("Template ID:", result.templateId);
console.log("Alias:      ", "corporation-base");
console.log(
	"\nSet E2B_BASE_TEMPLATE_ID in your environment to use this template for snapshot builds."
);
