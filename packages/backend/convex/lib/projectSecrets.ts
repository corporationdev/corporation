import { secretNameSchema, secretValueSchema } from "@tendril/shared/secrets";
import { ConvexError } from "convex/values";

export function validateProjectSecretName(name: string): void {
	const result = secretNameSchema.safeParse(name);
	if (!result.success) {
		throw new ConvexError(
			result.error.issues[0]?.message ?? "Invalid secret name"
		);
	}
}

export function validateProjectSecretValue(value: string): void {
	const result = secretValueSchema.safeParse(value);
	if (!result.success) {
		throw new ConvexError(
			result.error.issues[0]?.message ?? "Invalid secret value"
		);
	}
}
