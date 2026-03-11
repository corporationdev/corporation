import { z } from "zod";

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

const RESERVED_SECRET_NAMES = new Set([
	"CORPORATION_CONVEX_SITE_URL",
	"CORPORATION_SANDBOX_OWNER_ID",
	"CORPORATION_SERVER_URL",
	"HOME",
	"NODE_OPTIONS",
	"PATH",
	"PWD",
	"SHELL",
]);

const RESERVED_SECRET_PREFIXES = ["CORPORATION_"];

export const MAX_SECRET_NAME_LENGTH = 128;
export const MAX_SECRET_VALUE_LENGTH = 16_384;

export const secretNameSchema = z
	.string()
	.min(1, "Secret name is required")
	.max(MAX_SECRET_NAME_LENGTH, "Secret name must be at most 128 characters")
	.regex(
		ENV_VAR_NAME_RE,
		"Secret names must look like environment variables, for example DATABASE_URL"
	)
	.superRefine((name, ctx) => {
		if (RESERVED_SECRET_NAMES.has(name)) {
			ctx.addIssue({
				code: "custom",
				message: `Secret name ${name} is reserved`,
			});
		}
		if (RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))) {
			ctx.addIssue({
				code: "custom",
				message: `Secret names starting with ${RESERVED_SECRET_PREFIXES.join(", ")} are reserved`,
			});
		}
	});

export const secretValueSchema = z
	.string()
	.max(
		MAX_SECRET_VALUE_LENGTH,
		"Secret values must be at most 16384 characters"
	);

export function validateSecretName(name: string): string | undefined {
	const result = secretNameSchema.safeParse(name);
	if (!result.success) {
		return result.error.issues[0]?.message ?? "Invalid secret name";
	}
	return undefined;
}

export function validateSecretValue(value: string): string | undefined {
	const result = secretValueSchema.safeParse(value);
	if (!result.success) {
		return result.error.issues[0]?.message ?? "Invalid secret value";
	}
	return undefined;
}

export function buildSecretHint(value: string): string {
	return value.length <= 4 ? "****" : `...${value.slice(-4)}`;
}
