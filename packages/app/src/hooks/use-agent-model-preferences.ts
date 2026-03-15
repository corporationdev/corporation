import { useLocalStorage } from "@uidotdev/usehooks";
import { useCallback, useMemo } from "react";

const STORAGE_KEY = "tendril:agent-model-preferences";

const DEFAULT_AGENT_ID = "claude-acp";
const DEFAULT_MODEL_ID = "default";

type AgentModelPreferences = {
	agentId: string;
	modelId: string;
	/** Mode per agent - each agent has different mode options */
	modeByAgent: Record<string, string>;
};

const DEFAULT_PREFERENCES: AgentModelPreferences = {
	agentId: DEFAULT_AGENT_ID,
	modelId: DEFAULT_MODEL_ID,
	modeByAgent: {},
};

export function useAgentModelPreferences(options?: {
	/** Modes per agent - used to normalize stored value and get default */
	modesByAgent?: Record<string, { id: string }[]>;
}) {
	const [preferences, setPreferences] = useLocalStorage<AgentModelPreferences>(
		STORAGE_KEY,
		DEFAULT_PREFERENCES
	);

	const agentId = preferences.agentId ?? DEFAULT_AGENT_ID;
	const modelId = preferences.modelId ?? DEFAULT_MODEL_ID;
	const modeByAgent = preferences.modeByAgent ?? {};

	const modesForAgent = options?.modesByAgent?.[agentId] ?? [];

	const modeId = useMemo(() => {
		const stored = modeByAgent[agentId];
		const validIds = modesForAgent.map((m) => m.id);
		if (stored && validIds.includes(stored)) {
			return stored;
		}
		return modesForAgent[0]?.id ?? "";
	}, [agentId, modeByAgent, modesForAgent]);

	const setAgentId = useCallback(
		(agentId: string) => {
			setPreferences((prev) => ({
				...prev,
				agentId,
			}));
		},
		[setPreferences]
	);

	const setModelId = useCallback(
		(modelId: string) => {
			setPreferences((prev) => ({
				...prev,
				modelId,
			}));
		},
		[setPreferences]
	);

	const setModeId = useCallback(
		(modeId: string) => {
			setPreferences((prev) => ({
				...prev,
				modeByAgent: {
					...(prev.modeByAgent ?? {}),
					[agentId]: modeId,
				},
			}));
		},
		[setPreferences, agentId]
	);

	return {
		agentId,
		modelId,
		modeId,
		setAgentId,
		setModelId,
		setModeId,
	};
}
