const BRANCH_ALLOWED_CHARS_RE = /^[A-Za-z0-9._/-]+$/;
const BRANCH_DISALLOWED_SEQUENCE_RE = /(\.\.|@{|\\|\/\/)/;
const MAX_BRANCH_NAME_LENGTH = 120;

export function normalizeBranchName(branchName: string): string {
	const normalized = branchName.trim();

	if (!normalized) {
		throw new Error("Branch name cannot be empty");
	}

	if (normalized.length > MAX_BRANCH_NAME_LENGTH) {
		throw new Error(
			`Branch name must be ${MAX_BRANCH_NAME_LENGTH} characters or fewer`
		);
	}

	if (!BRANCH_ALLOWED_CHARS_RE.test(normalized)) {
		throw new Error(
			"Branch name may only include letters, numbers, '.', '_', '-', and '/'"
		);
	}

	if (normalized.startsWith("-")) {
		throw new Error("Branch name cannot start with '-'");
	}

	if (normalized.startsWith("/") || normalized.endsWith("/")) {
		throw new Error("Branch name cannot start or end with '/'");
	}

	if (normalized.endsWith(".")) {
		throw new Error("Branch name cannot end with '.'");
	}

	if (normalized.endsWith(".lock")) {
		throw new Error("Branch name cannot end with '.lock'");
	}

	if (BRANCH_DISALLOWED_SEQUENCE_RE.test(normalized)) {
		throw new Error("Branch name contains invalid git ref sequences");
	}

	if (
		normalized
			.split("/")
			.some((segment) => segment === "." || segment === ".." || !segment)
	) {
		throw new Error("Branch name contains invalid path segments");
	}

	return normalized;
}

export function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
