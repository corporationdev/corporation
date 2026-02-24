import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import {
	useMutation,
	useQuery as useTanstackQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation as useConvexMutation, useQuery } from "convex/react";
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api-client";

export const Route = createFileRoute("/_authenticated/settings/repositories/")({
	component: RepositoriesPage,
});

function SnapshotStatusIndicator({
	status,
	isOutdated,
	isChecking,
}: {
	status: "building" | "ready" | "error" | null;
	isOutdated: boolean;
	isChecking: boolean;
}) {
	if (!status) {
		return null;
	}

	if (status === "building") {
		return (
			<span className="flex items-center gap-1 text-muted-foreground text-xs">
				<Loader2 className="size-3 animate-spin" />
				Building
			</span>
		);
	}

	if (status === "ready" && isChecking) {
		return (
			<span className="flex items-center gap-1 text-muted-foreground text-xs">
				<Loader2 className="size-3 animate-spin" />
				Checking
			</span>
		);
	}

	if (status === "ready" && isOutdated) {
		return (
			<span className="flex items-center gap-1 text-amber-600 text-xs">
				<span className="size-1.5 rounded-full bg-amber-500" />
				Out of date
			</span>
		);
	}

	if (status === "ready") {
		return (
			<span className="flex items-center gap-1 text-emerald-600 text-xs">
				<span className="size-1.5 rounded-full bg-emerald-500" />
				Ready
			</span>
		);
	}

	return (
		<span className="flex items-center gap-1 text-destructive text-xs">
			<span className="size-1.5 rounded-full bg-destructive" />
			Error
		</span>
	);
}

function RepositoryCard({
	repository,
	isOutdated,
	isChecking,
}: {
	repository: {
		_id: Id<"repositories">;
		owner: string;
		name: string;
		defaultEnvironment: {
			_id: Id<"environments">;
			snapshotStatus: "building" | "ready" | "error";
		} | null;
	};
	isOutdated: boolean;
	isChecking: boolean;
}) {
	const deleteRepo = useConvexMutation(api.repositories.delete);
	const rebuildEnv = useConvexMutation(api.environments.rebuildSnapshot);

	const { mutate: removeRepository, isPending: isDeleting } = useMutation({
		mutationFn: async (id: Id<"repositories">) => {
			await deleteRepo({ id });
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const { mutate: rebuild, isPending: isRebuilding } = useMutation({
		mutationFn: async (id: Id<"environments">) => {
			await rebuildEnv({ id });
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	return (
		<Card size="sm">
			<CardHeader>
				<div className="flex items-center gap-3">
					<CardTitle>
						{repository.owner}/{repository.name}
					</CardTitle>
					<SnapshotStatusIndicator
						isChecking={isChecking}
						isOutdated={isOutdated}
						status={repository.defaultEnvironment?.snapshotStatus ?? null}
					/>
				</div>
				<CardAction>
					<div className="flex items-center gap-1">
						{isOutdated && repository.defaultEnvironment ? (
							<Button
								disabled={isRebuilding}
								onClick={() => {
									if (repository.defaultEnvironment) {
										rebuild(repository.defaultEnvironment._id);
									}
								}}
								size="icon-sm"
								variant="ghost"
							>
								<RefreshCw className="size-4" />
							</Button>
						) : null}
						<Link
							params={{ repositoryId: repository._id }}
							to="/settings/repositories/$repositoryId/edit"
						>
							<Button size="icon-sm" variant="ghost">
								<Pencil className="size-4" />
							</Button>
						</Link>
						<Button
							disabled={isDeleting}
							onClick={() => removeRepository(repository._id)}
							size="icon-sm"
							variant="ghost"
						>
							<Trash2 className="size-4" />
						</Button>
					</div>
				</CardAction>
			</CardHeader>
		</Card>
	);
}

function RepositoriesPage() {
	const repositories = useQuery(api.repositories.list);
	const isLoading = repositories === undefined;

	const { data: latestShas, isPending: shasPending } = useTanstackQuery({
		queryKey: ["latest-shas", repositories?.map((r) => r._id)],
		queryFn: async () => {
			if (!repositories?.length) {
				return {};
			}
			const res = await apiClient.github["latest-shas"].$get({
				query: {
					repos: JSON.stringify(
						repositories.map((r) => ({
							owner: r.owner,
							name: r.name,
							defaultBranch: r.defaultBranch,
						}))
					),
				},
			});
			if (!res.ok) {
				return {};
			}
			const data = await res.json();
			return data.shas;
		},
		enabled: !!repositories?.length,
	});

	return (
		<div className="p-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="font-semibold text-lg">Repositories</h1>
					<p className="mt-1 text-muted-foreground text-sm">
						Manage your repositories and their environment configuration.
					</p>
				</div>
				<Link to="/settings/repositories/connect">
					<Button size="sm" variant="outline">
						<Plus className="size-4" />
						Connect Repository
					</Button>
				</Link>
			</div>

			<div className="mt-4">
				{isLoading ? (
					<div className="flex flex-col gap-3">
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-16 w-full" />
					</div>
				) : repositories.length ? (
					<div className="flex flex-col gap-3">
						{repositories.map((repo) => {
							const key = `${repo.owner}/${repo.name}`;
							const latestSha = latestShas?.[key];
							const isOutdated =
								!!latestSha &&
								(!repo.defaultEnvironment?.snapshotCommitSha ||
									latestSha !== repo.defaultEnvironment.snapshotCommitSha);

							return (
								<RepositoryCard
									isChecking={shasPending}
									isOutdated={isOutdated}
									key={repo._id}
									repository={repo}
								/>
							);
						})}
					</div>
				) : (
					<p className="text-muted-foreground text-sm">
						No repositories connected yet.
					</p>
				)}
			</div>
		</div>
	);
}
