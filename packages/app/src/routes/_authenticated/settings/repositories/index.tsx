import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";

export const Route = createFileRoute("/_authenticated/settings/repositories/")({
	component: RepositoriesPage,
});

function SnapshotStatusIndicator({
	status,
}: {
	status: "building" | "ready" | "error" | null;
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
}: {
	repository: {
		_id: Id<"repositories">;
		owner: string;
		name: string;
		defaultEnvironment: {
			_id: Id<"environments">;
			latestSnapshot: { status: "building" | "ready" | "error" } | null;
		} | null;
	};
}) {
	const navigate = useNavigate();

	const { mutate: removeRepository, isPending: isDeleting } =
		useConvexTanstackMutation(api.repositories.delete, {
			onSuccess: () => {
				toast.success("Repository deleted");
				navigate({ to: "/settings/repositories" });
			},
			onError: (error) => {
				toast.error(error.message);
			},
		});

	return (
		<Card size="sm">
			<CardHeader>
				<div className="flex items-center gap-3">
					<Link
						className="hover:underline"
						params={{ repositoryId: repository._id }}
						to="/settings/repositories/$repositoryId"
					>
						<CardTitle>
							{repository.owner}/{repository.name}
						</CardTitle>
					</Link>
					<SnapshotStatusIndicator
						status={
							repository.defaultEnvironment?.latestSnapshot?.status ?? null
						}
					/>
				</div>
				<CardAction>
					<div className="flex items-center gap-1">
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
							onClick={() => removeRepository({ id: repository._id })}
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
						{repositories.map((repo) => (
							<RepositoryCard key={repo._id} repository={repo} />
						))}
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
