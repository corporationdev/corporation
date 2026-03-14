import acpAgents from "@tendril/config/acp-agent-manifest";
import type { AgentProbeAgent } from "@tendril/contracts/sandbox-do";

type DerivedAgentModel = {
	id: string;
	name: string;
};

export type AgentSelectorOption = {
	id: string;
	label: string;
	models: DerivedAgentModel[];
	defaultModelId: string | null;
};

type DerivedAgentModels = {
	models: DerivedAgentModel[];
	defaultModelId: string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function flattenConfigOptionValues(options: unknown): DerivedAgentModel[] {
	if (!Array.isArray(options)) {
		return [];
	}

	const values: DerivedAgentModel[] = [];
	for (const option of options) {
		if (!isObject(option)) {
			continue;
		}

		if (Array.isArray(option.options)) {
			values.push(...flattenConfigOptionValues(option.options));
			continue;
		}

		if (typeof option.value === "string" && typeof option.name === "string") {
			values.push({
				id: option.value,
				name: option.name,
			});
		}
	}

	return values;
}

function dedupeModels(models: DerivedAgentModel[]) {
	const deduped: DerivedAgentModel[] = [];
	const seen = new Set<string>();

	for (const model of models) {
		if (seen.has(model.id)) {
			continue;
		}
		seen.add(model.id);
		deduped.push(model);
	}

	return deduped;
}

export function deriveAgentModels(
	configOptions: AgentProbeAgent["configOptions"]
): DerivedAgentModels {
	if (!Array.isArray(configOptions)) {
		return {
			models: [],
			defaultModelId: null,
		};
	}

	const models: DerivedAgentModel[] = [];
	let defaultModelId: string | null = null;

	for (const option of configOptions) {
		if (!isObject(option) || option.category !== "model") {
			continue;
		}

		if (defaultModelId === null && typeof option.currentValue === "string") {
			defaultModelId = option.currentValue;
		}

		models.push(...flattenConfigOptionValues(option.options));
	}

	const dedupedModels = dedupeModels(models);

	return {
		models: dedupedModels,
		defaultModelId: defaultModelId ?? dedupedModels[0]?.id ?? null,
	};
}

const MANIFEST_AGENT_BY_ID = new Map(
	acpAgents.map((agent) => [agent.id, agent])
);

export function deriveAgentSelectorOptions(
	agentConfigs:
		| Array<{
				agentId: string;
				configOptions: AgentProbeAgent["configOptions"];
		  }>
		| null
		| undefined
): AgentSelectorOption[] {
	if (!agentConfigs) {
		return [];
	}

	const selectorOptions: AgentSelectorOption[] = [];

	for (const agentConfig of agentConfigs) {
		const manifestAgent = MANIFEST_AGENT_BY_ID.get(agentConfig.agentId);
		if (!manifestAgent) {
			continue;
		}

		const derivedModels = deriveAgentModels(agentConfig.configOptions);
		if (derivedModels.models.length === 0 || !derivedModels.defaultModelId) {
			continue;
		}

		selectorOptions.push({
			id: manifestAgent.id,
			label: manifestAgent.name,
			models: derivedModels.models,
			defaultModelId: derivedModels.defaultModelId,
		});
	}

	return selectorOptions;
}
