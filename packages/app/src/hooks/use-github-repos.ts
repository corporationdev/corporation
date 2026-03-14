import { useQuery } from "@tanstack/react-query";
import { api } from "@tendril/backend/convex/_generated/api";
import { useQuery as useConvexQuery } from "convex/react";
import { type GitHubRepository, listGitHubRepos } from "@/lib/api-client";

export type GitHubRepo = GitHubRepository;

export function useGitHubRepos(options?: { excludeConnected?: boolean }) {
	const connectedRepos = useConvexQuery(
		api.projects.list,
		options?.excludeConnected ? {} : "skip"
	);

	const query = useQuery({
		queryKey: ["github-repos"],
		queryFn: listGitHubRepos,
	});

	if (!options?.excludeConnected) {
		return query;
	}

	const connectedIds = new Set(
		connectedRepos?.flatMap((p) => (p.githubRepoId ? [p.githubRepoId] : []))
	);

	return {
		...query,
		data: query.data?.filter((repo) => !connectedIds.has(repo.id)),
	};
}
