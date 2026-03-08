import { useCallback, useEffect, useState } from "react";
import agentModelsData from "@/data/agent-models.json";

const STORAGE_KEY = "corporation:agent-model-selection";
const STORAGE_VERSION = 1;

const INITIAL_AGENT = "claude";
const INITIAL_MODEL =
	agentModelsData[INITIAL_AGENT as keyof typeof agentModelsData].defaultModel ??
	"";

type StoredSelection = {
	v: number;
	agent: string;
	modelId: string;
};

type AgentModelSelection = {
	agent: string;
	modelId: string;
};

function isKnownAgent(agent: string): agent is keyof typeof agentModelsData {
	return agent in agentModelsData;
}

function getFallbackModelId(agent: keyof typeof agentModelsData) {
	return (
		agentModelsData[agent].defaultModel ??
		agentModelsData[agent].models[0]?.id ??
		INITIAL_MODEL
	);
}

function normalizeSelection(
	value: Partial<AgentModelSelection> | null | undefined
): AgentModelSelection {
	const agent =
		typeof value?.agent === "string" && isKnownAgent(value.agent)
			? value.agent
			: INITIAL_AGENT;
	const models = agentModelsData[agent].models;
	const modelId =
		typeof value?.modelId === "string" &&
		models.some((model) => model.id === value.modelId)
			? value.modelId
			: getFallbackModelId(agent);

	return { agent, modelId };
}

function readSelection() {
	if (typeof window === "undefined") {
		return normalizeSelection(null);
	}

	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return normalizeSelection(null);
		}

		const parsed = JSON.parse(raw) as StoredSelection | AgentModelSelection;
		return normalizeSelection(parsed);
	} catch {
		return normalizeSelection(null);
	}
}

function writeSelection(selection: AgentModelSelection) {
	if (typeof window === "undefined") {
		return;
	}

	const payload: StoredSelection = {
		v: STORAGE_VERSION,
		...selection,
	};
	window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function areSelectionsEqual(
	left: AgentModelSelection,
	right: AgentModelSelection
) {
	return left.agent === right.agent && left.modelId === right.modelId;
}

export function usePersistedAgentModelSelection() {
	const [selection, setSelection] = useState<AgentModelSelection>(() =>
		readSelection()
	);

	useEffect(() => {
		const nextSelection = readSelection();
		setSelection((currentSelection) =>
			areSelectionsEqual(currentSelection, nextSelection)
				? currentSelection
				: nextSelection
		);

		const handleStorage = (event: StorageEvent) => {
			if (event.key !== STORAGE_KEY && event.key !== null) {
				return;
			}

			setSelection(readSelection());
		};

		window.addEventListener("storage", handleStorage);
		return () => window.removeEventListener("storage", handleStorage);
	}, []);

	useEffect(() => {
		writeSelection(selection);
	}, [selection]);

	const setAgent = useCallback((agent: string) => {
		setSelection((currentSelection) =>
			normalizeSelection({ agent, modelId: currentSelection.modelId })
		);
	}, []);

	const setModelId = useCallback((modelId: string) => {
		setSelection((currentSelection) =>
			normalizeSelection({ agent: currentSelection.agent, modelId })
		);
	}, []);

	return {
		agent: selection.agent,
		modelId: selection.modelId,
		setAgent,
		setModelId,
	};
}
