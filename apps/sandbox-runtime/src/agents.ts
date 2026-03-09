import fs from "node:fs";
import claudeCodeSettings from "./agent-configs/claude-code-settings.json";
import { log } from "./logging";

const AGENT_NPX_PACKAGES: Record<string, string> = {
	claude: "@zed-industries/claude-code-acp",
	codex: "@zed-industries/codex-acp",
	pi: "pi-acp",
	cursor: "@blowmage/cursor-agent-acp",
};
const SANDBOX_HOME_DIR = process.env.HOME || "/home/user";

function stringEnv(): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string"
		)
	);
}

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

export function agentEnv(agent: string): Record<string, string> {
	const env = stringEnv();

	if (agent !== "claude") {
		return env as Record<string, string>;
	}

	// Claude Code ACP consumes credentials from the process environment.
	// If an OAuth token is available, prefer it and omit the API key.
	if (env.CLAUDE_CODE_OAUTH_TOKEN) {
		env.ANTHROPIC_API_KEY = undefined;
	}

	return Object.fromEntries(
		Object.entries(env).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string"
		)
	);
}

/** Map of agent name -> array of { path, content } config files to write before spawning. */
const AGENT_CONFIGS: Record<string, { path: string; content: string }[]> = {
	claude: [
		{
			path: `${SANDBOX_HOME_DIR}/.claude/settings.json`,
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
