import fs from "node:fs";
import claudeCodeSettings from "./agent-configs/claude-code-settings.json";
import { log } from "./logging";

const AGENT_NPX_PACKAGES: Record<string, string> = {
	claude: "@zed-industries/claude-code-acp",
	codex: "@zed-industries/codex-acp",
	pi: "pi-acp",
	cursor: "@blowmage/cursor-agent-acp",
};

export function agentCommand(agent: string): string[] {
	if (agent === "opencode") {
		return ["opencode", "acp"];
	}
	if (agent === "amp") {
		return ["amp-acp"];
	}

	const pkg = AGENT_NPX_PACKAGES[agent];
	if (!pkg) {
		throw new Error(`Unknown agent: ${agent}`);
	}
	return ["npx", "-y", pkg];
}

/** Map of agent name -> array of { path, content } config files to write before spawning. */
const AGENT_CONFIGS: Record<string, { path: string; content: string }[]> = {
	claude: [
		{
			path: "/root/.claude/settings.json",
			content: JSON.stringify(claudeCodeSettings),
		},
	],
};

export function writeAgentConfigs(agent: string): void {
	const configs = AGENT_CONFIGS[agent];
	if (!configs) {
		return;
	}
	for (const { path: filePath, content } of configs) {
		const dir = filePath.substring(0, filePath.lastIndexOf("/"));
		if (dir) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(filePath, content);
		log("info", `Wrote agent config: ${filePath}`);
	}
}
