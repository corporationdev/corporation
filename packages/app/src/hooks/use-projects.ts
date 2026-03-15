import { api } from "@tendril/backend/convex/_generated/api";
import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useMemo } from "react";

const PROJECTS_CACHE_KEY = "tendril:projects-cache";
const SELECTED_PROJECT_KEY = "tendril:recent-project";

export type Project = FunctionReturnType<typeof api.projects.list>[number];

function readCachedProjects(): Project[] | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		const raw = window.localStorage.getItem(PROJECTS_CACHE_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as Project[];
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function writeCachedProjects(projects: Project[]) {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify(projects));
	} catch {
		// ignore
	}
}

export function useProjects() {
	const queryResult = useQuery(api.projects.list);
	const [selectedProjectId, setSelectedProjectId] =
		useLocalStorage<Id<"projects"> | null>(SELECTED_PROJECT_KEY, null);

	// Stale-while-revalidate: persist fresh data to cache when it arrives
	useEffect(() => {
		if (queryResult !== undefined && Array.isArray(queryResult)) {
			writeCachedProjects(queryResult);
		}
	}, [queryResult]);

	// Use cached data when query is loading (stale), otherwise use fresh data
	const projects = useMemo(() => {
		if (queryResult !== undefined) {
			return queryResult;
		}
		return readCachedProjects() ?? [];
	}, [queryResult]);

	const isLoading = queryResult === undefined && projects.length === 0;
	const isRevalidating = queryResult === undefined && projects.length > 0;

	const setSelected = useCallback(
		(id: Id<"projects"> | null) => {
			setSelectedProjectId(id);
		},
		[setSelectedProjectId]
	);

	return {
		projects,
		selectedProjectId,
		setSelectedProjectId: setSelected,
		isLoading,
		isRevalidating,
	};
}
