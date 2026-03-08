export const CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const CLAUDE_CODE_OAUTH_TOKEN_ENV_PATTERN =
	/(?:^|\b)(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*['"]?([^'"\s]+)['"]?/m;
const WHITESPACE_PATTERN = /\s/;
const WHITESPACE_GLOBAL_PATTERN = /\s+/g;

export function normalizeClaudeCodeOauthToken(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Missing Claude Code OAuth token");
	}

	const envMatch = trimmed.match(CLAUDE_CODE_OAUTH_TOKEN_ENV_PATTERN);
	const token = (envMatch?.[1] ?? trimmed)
		.trim()
		.replace(WHITESPACE_GLOBAL_PATTERN, "");

	if (!token || WHITESPACE_PATTERN.test(token)) {
		throw new Error("Invalid Claude Code OAuth token");
	}

	return token;
}

export function buildClaudeCodeOauthHint(token: string): string {
	if (token.length <= 4) {
		return "Claude Code subscription";
	}

	return `Claude Code subscription · ...${token.slice(-4)}`;
}
