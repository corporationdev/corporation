import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useCallback } from "react";

const STORAGE_KEY = "tendril:environment-selection";

export type EnvironmentSelection = Id<"environments"> | "new-sandbox";

const DEFAULT_ENVIRONMENT: EnvironmentSelection = "new-sandbox";

export function useEnvironmentSelection() {
	const [environmentId, setEnvironmentId] =
		useLocalStorage<EnvironmentSelection>(STORAGE_KEY, DEFAULT_ENVIRONMENT);

	const value = environmentId ?? DEFAULT_ENVIRONMENT;

	const setValue = useCallback(
		(v: EnvironmentSelection) => {
			setEnvironmentId(v);
		},
		[setEnvironmentId]
	);

	return { environmentId: value, setEnvironmentId: setValue };
}
