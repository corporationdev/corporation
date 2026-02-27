import { createHash } from "node:crypto";
import { hostname } from "node:os";

export type EnvTier = "dev" | "preview" | "prod";
export type StageMode = "dev" | "sandbox";
export type StageKind =
	| "dev"
	| "sandbox"
	| "preview"
	| "production"
	| "unknown";

const SLUG_NON_ALPHANUMERIC_REGEX = /[^a-z0-9-]+/g;
const SLUG_MULTIPLE_DASHES_REGEX = /-+/g;
const LEADING_DASHES_REGEX = /^-+/;
const TRAILING_DASHES_REGEX = /-+$/;

const MAX_STAGE_LENGTH = 63;

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(SLUG_NON_ALPHANUMERIC_REGEX, "-")
		.replace(SLUG_MULTIPLE_DASHES_REGEX, "-")
		.replace(LEADING_DASHES_REGEX, "")
		.replace(TRAILING_DASHES_REGEX, "");
}

function shortHash(input: string, length = 8): string {
	return createHash("sha256").update(input).digest("hex").slice(0, length);
}

function trimStage(stage: string): string {
	return stage.slice(0, MAX_STAGE_LENGTH).replace(TRAILING_DASHES_REGEX, "");
}

function getUserSlug(): string {
	const user = process.env.USER ?? process.env.USERNAME ?? "user";
	return slugify(user) || "user";
}

export function resolveStage(mode: StageMode): string {
	if (mode === "sandbox") {
		return "sandbox";
	}
	const userSlug = getUserSlug();

	const suffix = shortHash(`${userSlug}:${hostname()}`);
	return trimStage(`dev-${userSlug}-${suffix}`);
}

export function getStageKind(stage: string): StageKind {
	if (stage === "sandbox" || stage.startsWith("sandbox-")) {
		return "sandbox";
	}
	if (stage === "dev" || stage.startsWith("dev-")) {
		return "dev";
	}
	if (
		stage === "preview" ||
		stage.startsWith("preview-") ||
		stage.startsWith("pr-")
	) {
		return "preview";
	}
	if (
		stage === "prod" ||
		stage === "production" ||
		stage.startsWith("prod-") ||
		stage.startsWith("production-")
	) {
		return "production";
	}
	return "unknown";
}

export function deriveEnvTier(stage: string): EnvTier {
	const stageKind = getStageKind(stage);
	if (stageKind === "production") {
		return "prod";
	}
	if (stageKind === "preview") {
		return "preview";
	}
	return "dev";
}
