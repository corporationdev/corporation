export type EnvTier = "dev" | "preview" | "prod";
export type StageKind =
	| "dev"
	| "sandbox"
	| "preview"
	| "production"
	| "unknown";

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
