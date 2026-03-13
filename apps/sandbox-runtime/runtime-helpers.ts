import type {
	ModelRef,
	PromptPart,
	RuntimeMessagePart,
	RuntimePermissionRequest,
	SessionDynamicConfig,
	SessionId,
	SessionStaticConfig,
} from "./runtime-types";

export function getConfigDiff(
	current: SessionDynamicConfig,
	incoming: SessionDynamicConfig | undefined
): SessionDynamicConfig | null {
	if (!incoming) {
		return null;
	}

	const diff: SessionDynamicConfig = {};
	if (incoming.modelId !== undefined && incoming.modelId !== current.modelId) {
		diff.modelId = incoming.modelId;
	}
	if (incoming.modeId !== undefined && incoming.modeId !== current.modeId) {
		diff.modeId = incoming.modeId;
	}
	if (incoming.configOptions) {
		const changedOptions: Record<string, string> = {};
		for (const [key, value] of Object.entries(incoming.configOptions)) {
			if (value !== current.configOptions?.[key]) {
				changedOptions[key] = value;
			}
		}
		if (Object.keys(changedOptions).length > 0) {
			diff.configOptions = changedOptions;
		}
	}

	if (
		diff.modelId === undefined &&
		diff.modeId === undefined &&
		diff.configOptions === undefined
	) {
		return null;
	}

	return diff;
}

export function cloneStaticConfig(
	config: SessionStaticConfig
): SessionStaticConfig {
	return { ...config };
}

export function cloneDynamicConfig(
	config: SessionDynamicConfig
): SessionDynamicConfig {
	return {
		...config,
		...(config.configOptions
			? { configOptions: { ...config.configOptions } }
			: {}),
	};
}

export function mergeDynamicConfig(
	current: SessionDynamicConfig,
	next: SessionDynamicConfig
): SessionDynamicConfig {
	return {
		...current,
		...next,
		...(current.configOptions || next.configOptions
			? {
					configOptions: {
						...(current.configOptions ?? {}),
						...(next.configOptions ?? {}),
					},
				}
			: {}),
	};
}

export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function toUnknownError(error: unknown): string {
	return toErrorMessage(error);
}

export function toAbortedError(): string {
	return "Session aborted";
}

export function defaultSessionTitle(directory: string): string {
	const segments = directory.split("/").filter(Boolean);
	return segments.at(-1) ?? directory;
}

export function toPromptParts(parts: PromptPart[]): PromptPart[] {
	return parts.map((part) => ({
		type: "text",
		text: part.text,
	}));
}

export function resolvePermissionOptionId(
	permission: RuntimePermissionRequest,
	response: "once" | "always"
): string {
	const desiredKind = response === "always" ? "allow_always" : "allow_once";
	const match = permission.options.find((option) => option.kind === desiredKind);
	if (!match) {
		throw new Error(
			`Permission ${permission.id} does not support response ${response}`
		);
	}
	return match.optionId;
}

export function toUserPart(
	sessionId: SessionId,
	messageId: string,
	part: PromptPart
): RuntimeMessagePart {
	return {
		id: crypto.randomUUID(),
		sessionId,
		messageId,
		type: "text",
		text: part.text,
	};
}

export function toDefaultModel(
	agent: string,
	model: ModelRef | null,
	dynamicConfig: SessionDynamicConfig
): ModelRef {
	return (
		model ?? {
			providerID: agent,
			modelID: dynamicConfig.modelId ?? "default",
		}
	);
}
