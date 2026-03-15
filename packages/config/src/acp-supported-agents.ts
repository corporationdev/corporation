export type AgentCredentialBundle = {
	schemaVersion: number;
	paths: Array<{
		path: string;
		kind: "file" | "dir";
		required?: boolean;
	}>;
	exclude?: string[];
};

export type AgentNativeCliInstall =
	| {
			kind: "manual";
			docsUrl: string;
	  }
	| {
			kind: "npm";
			package: string;
	  }
	| {
			kind: "binary";
			platforms: Record<
				string,
				{
					archive: string;
					cmd: string;
				}
			>;
	  };

export type SupportedAcpAgentConfig = {
	id: string;
	nativeCli: {
		displayName: string;
		executableNames: string[];
		install: AgentNativeCliInstall;
	};
	acpAdapter: {
		executableName?: string | null;
	};
	credentialBundle: AgentCredentialBundle;
};

export const SUPPORTED_ACP_AGENTS = [
	{
		id: "claude-acp",
		nativeCli: {
			displayName: "Claude Code",
			executableNames: ["claude"],
			install: {
				kind: "npm",
				package: "@anthropic-ai/claude-code",
			},
		},
		acpAdapter: {
			executableName: "claude-agent-acp",
		},
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
		nativeCli: {
			displayName: "Codex CLI",
			executableNames: ["codex"],
			install: {
				kind: "npm",
				package: "@openai/codex",
			},
		},
		acpAdapter: {},
		credentialBundle: {
			schemaVersion: 1,
			paths: [{ path: "$HOME/.codex/auth.json", kind: "file", required: true }],
		},
	},
] as const satisfies readonly SupportedAcpAgentConfig[];
