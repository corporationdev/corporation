export type EnvByPath = Record<string, Record<string, string>>;
const LEADING_DOT_SLASH_RE = /^\.\/+/;
const TRAILING_SLASH_RE = /\/+$/;

function normalizePath(inputPath: string): string {
	const trimmed = inputPath.trim();
	if (!trimmed) {
		return ".";
	}

	const withoutLeadingDotSlash = trimmed.replace(LEADING_DOT_SLASH_RE, "");
	const withoutTrailingSlash = withoutLeadingDotSlash.replace(
		TRAILING_SLASH_RE,
		""
	);

	return withoutTrailingSlash || ".";
}

export function normalizeEnvByPath(
	envByPath: EnvByPath | undefined
): EnvByPath | undefined {
	if (!envByPath) {
		return undefined;
	}

	const normalized: EnvByPath = {};

	for (const [path, envMap] of Object.entries(envByPath)) {
		const normalizedPath = normalizePath(path);
		const pathEnv = normalized[normalizedPath] ?? {};

		for (const [key, value] of Object.entries(envMap)) {
			const normalizedKey = key.trim();
			if (!normalizedKey) {
				continue;
			}
			pathEnv[normalizedKey] = value;
		}

		normalized[normalizedPath] = pathEnv;
	}

	return normalized;
}
