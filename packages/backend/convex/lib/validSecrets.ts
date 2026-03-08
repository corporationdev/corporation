/**
 * Allowed secret names that can be stored via the secrets.upsert mutation.
 * Keep in sync with the AUTH_CONFIG in scripts/generate-acp-agents.ts.
 */
export const VALID_SECRET_NAMES = new Set([
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"CURSOR_API_KEY",
	"GEMINI_API_KEY",
	"GITHUB_TOKEN",
	"AUGMENT_API_KEY",
]);
