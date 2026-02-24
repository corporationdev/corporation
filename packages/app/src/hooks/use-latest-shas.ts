import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

type Repo = { owner: string; name: string; defaultBranch: string };

export function useLatestShas(repos: Repo[], enabled: boolean) {
	return useTanstackQuery({
		queryKey: [
			"latest-shas",
			repos.map((r) => `${r.owner}/${r.name}/${r.defaultBranch}`),
		],
		queryFn: async () => {
			const res = await apiClient.github["latest-shas"].$get({
				query: { repos: JSON.stringify(repos) },
			});
			if (!res.ok) {
				return {} as Record<string, string>;
			}
			const data = await res.json();
			return data.shas;
		},
		refetchInterval: 60_000,
		enabled: enabled && repos.length > 0,
	});
}
