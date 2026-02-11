import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";

import { apiClient } from "@/lib/api-client";

type GitHubReposResponse = InferResponseType<
	typeof apiClient.repositories.github.$get,
	200
>;

export type GitHubRepo = GitHubReposResponse["repositories"][number];

async function fetchGitHubRepos() {
	const res = await apiClient.repositories.github.$get({});
	if (!res.ok) {
		throw new Error("Failed to fetch GitHub repositories");
	}
	const data = await res.json();
	return data.repositories;
}

export function useGitHubRepos() {
	return useQuery({
		queryKey: ["github-repos"],
		queryFn: fetchGitHubRepos,
	});
}
