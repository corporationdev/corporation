import { useCallback, useEffect, useState } from "react";
import type { AgentSelectorOption } from "@/lib/agent-config-options";

const STORAGE_KEY = "tendril:agent-model-selection";
const STORAGE_VERSION = 1;

type StoredSelection = {
	v: number;
	agent: string;
	modelId: string;
};

type AgentModelSelection = {
	agent: string;
	modelId: string;
};

function normalizeSelection(
	value: Partial<AgentModelSelection> | null | undefined,
	agentOptions: AgentSelectorOption[]
): AgentModelSelection {
	if (agentOptions.length === 0) {
		return { agent: "", modelId: "" };
	}

	const fallbackAgent = agentOptions[0];
	const selectedAgent =
		typeof value?.agent === "string"
			? (agentOptions.find((agentOption) => agentOption.id === value.agent) ??
				fallbackAgent)
			: fallbackAgent;
	const models = selectedAgent.models;
	const modelId =
		typeof value?.modelId === "string" &&
		models.some((model) => model.id === value.modelId)
			? value.modelId
			: (selectedAgent.defaultModelId ?? models[0]?.id ?? "");

	return { agent: selectedAgent.id, modelId };
}

function readSelection() {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return null;
		}

		const parsed = JSON.parse(raw) as StoredSelection | AgentModelSelection;
		return parsed;
	} catch {
		return null;
	}
}

function writeSelection(selection: AgentModelSelection) {
	if (!(selection.agent && selection.modelId)) {
		return;
	}

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

export function usePersistedAgentModelSelection(
	agentOptions: AgentSelectorOption[]
) {
	const [selection, setSelection] = useState<AgentModelSelection>(() =>
		normalizeSelection(readSelection(), agentOptions)
	);

	useEffect(() => {
		const nextSelection = normalizeSelection(readSelection(), agentOptions);
		setSelection((currentSelection) =>
			areSelectionsEqual(currentSelection, nextSelection)
				? currentSelection
				: nextSelection
		);

		const handleStorage = (event: StorageEvent) => {
			if (event.key !== STORAGE_KEY && event.key !== null) {
				return;
			}

			setSelection(normalizeSelection(readSelection(), agentOptions));
		};

		window.addEventListener("storage", handleStorage);
		return () => window.removeEventListener("storage", handleStorage);
	}, [agentOptions]);

	useEffect(() => {
		writeSelection(selection);
	}, [selection]);

	const setAgent = useCallback(
		(agent: string) => {
			setSelection((currentSelection) =>
				normalizeSelection(
					{ agent, modelId: currentSelection.modelId },
					agentOptions
				)
			);
		},
		[agentOptions]
	);

	const setModelId = useCallback(
		(modelId: string) => {
			setSelection((currentSelection) =>
				normalizeSelection(
					{ agent: currentSelection.agent, modelId },
					agentOptions
				)
			);
		},
		[agentOptions]
	);

	return {
		agent: selection.agent,
		modelId: selection.modelId,
		setAgent,
		setModelId,
	};
}
