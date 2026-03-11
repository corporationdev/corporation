import { api } from "@corporation/backend/convex/_generated/api";
import type { GitHubRepository } from "@corporation/contracts/orpc/worker-http";
import { useQuery } from "@tanstack/react-query";
import { useQuery as useConvexQuery } from "convex/react";
import { apiUtils } from "@/lib/api-client";

export type GitHubRepo = GitHubRepository;

export function useGitHubRepos(options?: { excludeConnected?: boolean }) {
	const connectedRepos = useConvexQuery(
		api.projects.list,
		options?.excludeConnected ? {} : "skip"
	);

	const query = useQuery({
		...apiUtils.github.listRepos.queryOptions(),
		select: (data) => data.repositories,
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
