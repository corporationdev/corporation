import { api } from "@corporation/backend/convex/_generated/api";
import { useQuery } from "@tanstack/react-query";
import { useQuery as useConvexQuery } from "convex/react";
import type { InferResponseType } from "hono/client";

import { apiClient } from "@/lib/api-client";

type GitHubReposResponse = InferResponseType<typeof apiClient.github.$get, 200>;

export type GitHubRepo = GitHubReposResponse["repositories"][number];

async function fetchGitHubRepos() {
	const res = await apiClient.github.$get({});
	if (!res.ok) {
		throw new Error("Failed to fetch GitHub repositories");
	}
	const data = await res.json();
	return data.repositories;
}

export function useGitHubRepos(options?: { excludeConnected?: boolean }) {
	const connectedRepos = useConvexQuery(
		api.repositories.list,
		options?.excludeConnected ? {} : "skip"
	);

	const query = useQuery({
		queryKey: ["github-repos"],
		queryFn: fetchGitHubRepos,
	});

	if (!options?.excludeConnected) {
		return query;
	}

	const connectedIds = new Set(connectedRepos?.map((r) => r.githubRepoId));

	return {
		...query,
		data: query.data?.filter((repo) => !connectedIds.has(repo.id)),
	};
}
