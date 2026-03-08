/**
 * Allowed secret names that can be stored via the secrets.upsert mutation.
 * Keep in sync with the AUTH_CONFIG in scripts/generate-acp-agents.ts.
 */
export const USER_CONFIGURABLE_SECRET_NAMES = new Set([
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"CURSOR_API_KEY",
	"GEMINI_API_KEY",
	"GITHUB_TOKEN",
	"AUGMENT_API_KEY",
]);

export const SYSTEM_SECRET_NAMES = new Set(["CODEX_AUTH_JSON"]);

export const VALID_SECRET_NAMES = new Set([
	...USER_CONFIGURABLE_SECRET_NAMES,
	...SYSTEM_SECRET_NAMES,
]);

export const ENV_SECRET_NAMES = new Set(USER_CONFIGURABLE_SECRET_NAMES);
