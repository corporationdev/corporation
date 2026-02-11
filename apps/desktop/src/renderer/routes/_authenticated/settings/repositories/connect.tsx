import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api-client";

export const Route = createFileRoute(
	"/_authenticated/settings/repositories/connect"
)({
	component: ConnectRepositoryPage,
});

async function fetchGitHubRepos() {
	const res = await apiClient.repositories.github.$get({});
	if (!res.ok) {
		throw new Error("Failed to fetch GitHub repositories");
	}
	const data = await res.json();
	return data.repositories;
}

function ConnectRepositoryPage() {
	const {
		data: repos,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["github-repos"],
		queryFn: fetchGitHubRepos,
	});

	return (
		<div className="p-6">
			<h1 className="font-semibold text-lg">Connect Repository</h1>
			<p className="mt-1 mb-4 text-muted-foreground text-sm">
				Select a GitHub repository to connect.
			</p>

			{error && (
				<p className="mb-4 text-destructive text-sm">{error.message}</p>
			)}

			{isLoading ? (
				<div className="flex flex-col gap-3">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : repos?.length ? (
				<div className="flex flex-col gap-3">
					{repos.map((repo) => (
						<Card key={repo.id} size="sm">
							<CardHeader>
								<div>
									<CardTitle>
										{repo.owner}/{repo.name}
									</CardTitle>
									<CardDescription>
										{repo.private ? "Private" : "Public"} · {repo.defaultBranch}
									</CardDescription>
								</div>
							</CardHeader>
						</Card>
					))}
				</div>
			) : (
				<p className="text-muted-foreground text-sm">No repositories found.</p>
			)}
		</div>
	);
}
