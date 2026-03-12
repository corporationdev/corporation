export type AgentCredentialBundle = {
	schemaVersion: number;
	paths: Array<{
		path: string;
		kind: "file" | "dir";
		required?: boolean;
	}>;
	exclude?: string[];
};

export type SupportedAcpAgentConfig = {
	id: string;
	nativeInstallCommand: string | null;
	runtimeCommandOverride?: {
		command: string;
		args?: string[];
		env?: Record<string, string>;
	} | null;
	acpInstallStrategy: "distribution" | "native";
	acpExecutableName: string | null;
	installSource: string;
	credentialBundle: AgentCredentialBundle;
};

export const SUPPORTED_ACP_AGENTS = [
	{
		id: "claude-acp",
		nativeInstallCommand:
			'npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code',
		acpInstallStrategy: "distribution",
		acpExecutableName: "claude-agent-acp",
		installSource: "https://docs.anthropic.com/en/docs/claude-code/setup",
		credentialBundle: {
			schemaVersion: 1,
			paths: [
				{ path: "$HOME/.claude.json", kind: "file", required: true },
				{
					path: "$HOME/.claude/.credentials.json",
					kind: "file",
					required: true,
				},
			],
		},
	},
	{
		id: "codex-acp",
		nativeInstallCommand:
			'npm install -g --prefix "$HOME/.local" @openai/codex',
		acpInstallStrategy: "distribution",
		acpExecutableName: null,
		installSource: "https://github.com/openai/codex",
		credentialBundle: {
			schemaVersion: 1,
			paths: [{ path: "$HOME/.codex/auth.json", kind: "file", required: true }],
		},
	},
] as const satisfies readonly SupportedAcpAgentConfig[];
