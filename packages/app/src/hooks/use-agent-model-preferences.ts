import { useLocalStorage } from "@uidotdev/usehooks";
import { useCallback, useMemo } from "react";

const STORAGE_KEY = "tendril:agent-model-preferences";

const DEFAULT_AGENT_ID = "claude-acp";

type AgentModelPreferences = {
	agentId: string;
	/** @deprecated — migrated to modelByAgent */
	modelId?: string;
	/** Model per agent - each agent has different model options */
	modelByAgent: Record<string, string>;
	/** Mode per agent - each agent has different mode options */
	modeByAgent: Record<string, string>;
	/** Reasoning effort per agent - only some agents support this */
	reasoningEffortByAgent: Record<string, string>;
};

const DEFAULT_PREFERENCES: AgentModelPreferences = {
	agentId: DEFAULT_AGENT_ID,
	modelByAgent: {},
	modeByAgent: {},
	reasoningEffortByAgent: {},
};

export function useAgentModelPreferences(options?: {
	/** Models per agent - used to normalize stored value and get default */
	modelsByAgent?: Record<string, { id: string }[]>;
	/** Modes per agent - used to normalize stored value and get default */
	modesByAgent?: Record<string, { id: string }[]>;
	/** Reasoning efforts per agent - used to normalize stored value and get default */
	reasoningEffortsByAgent?: Record<string, { id: string }[]>;
}) {
	const [preferences, setPreferences] = useLocalStorage<AgentModelPreferences>(
		STORAGE_KEY,
		DEFAULT_PREFERENCES
	);

	const agentId = preferences.agentId ?? DEFAULT_AGENT_ID;
	const modelByAgent = preferences.modelByAgent ?? {};
	const modeByAgent = preferences.modeByAgent ?? {};
	const reasoningEffortByAgent = preferences.reasoningEffortByAgent ?? {};

	const modelsForAgent = options?.modelsByAgent?.[agentId] ?? [];
	const modesForAgent = options?.modesByAgent?.[agentId] ?? [];
	const reasoningEffortsForAgent =
		options?.reasoningEffortsByAgent?.[agentId] ?? [];

	const modelId = useMemo(() => {
		const stored = modelByAgent[agentId];
		const validIds = modelsForAgent.map((m) => m.id);
		if (stored && validIds.includes(stored)) {
			return stored;
		}
		return modelsForAgent[0]?.id ?? "";
	}, [agentId, modelByAgent, modelsForAgent]);

	const modeId = useMemo(() => {
		const stored = modeByAgent[agentId];
		const validIds = modesForAgent.map((m) => m.id);
		if (stored && validIds.includes(stored)) {
			return stored;
		}
		return modesForAgent[0]?.id ?? "";
	}, [agentId, modeByAgent, modesForAgent]);

	const reasoningEffort = useMemo(() => {
		if (reasoningEffortsForAgent.length === 0) {
			return null;
		}
		const stored = reasoningEffortByAgent[agentId];
		const validIds = reasoningEffortsForAgent.map((r) => r.id);
		if (stored && validIds.includes(stored)) {
			return stored;
		}
		return reasoningEffortsForAgent[0]?.id ?? null;
	}, [agentId, reasoningEffortByAgent, reasoningEffortsForAgent]);

	const setAgentId = useCallback(
		(id: string) => {
			setPreferences((prev) => ({
				...prev,
				agentId: id,
			}));
		},
		[setPreferences]
	);

	const setModelId = useCallback(
		(model: string) => {
			setPreferences((prev) => ({
				...prev,
				modelByAgent: {
					...(prev.modelByAgent ?? {}),
					[agentId]: model,
				},
			}));
		},
		[setPreferences, agentId]
	);

	const setModeId = useCallback(
		(mode: string) => {
			setPreferences((prev) => ({
				...prev,
				modeByAgent: {
					...(prev.modeByAgent ?? {}),
					[agentId]: mode,
				},
			}));
		},
		[setPreferences, agentId]
	);

	const setReasoningEffort = useCallback(
		(effort: string) => {
			setPreferences((prev) => ({
				...prev,
				reasoningEffortByAgent: {
					...(prev.reasoningEffortByAgent ?? {}),
					[agentId]: effort,
				},
			}));
		},
		[setPreferences, agentId]
	);

	return {
		agentId,
		modelId,
		modeId,
		reasoningEffort,
		setAgentId,
		setModelId,
		setModeId,
		setReasoningEffort,
	};
}
