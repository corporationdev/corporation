import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api-client";

export const Route = createFileRoute("/_authenticated/settings/repositories/")({
	component: RepositoriesPage,
});

function RepositoryCard({
	repository,
}: {
	repository: {
		_id: string;
		owner: string;
		name: string;
		installCommand: string;
	};
}) {
	const { mutate: removeRepository, isPending: isDeleting } = useMutation({
		mutationFn: async (id: string) => {
			const res = await apiClient.repositories[":id"].$delete({
				param: { id },
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error);
			}
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});
	const environments = useQuery(api.environments.listByRepository, {
		repositoryId: repository._id as Id<"repositories">,
	});
	const environment = environments?.[0];

	return (
		<Card size="sm">
			<CardHeader>
				<div>
					<CardTitle>
						{repository.owner}/{repository.name}
					</CardTitle>
					<CardDescription>
						{repository.installCommand || environment?.devCommand
							? [repository.installCommand, environment?.devCommand]
									.filter(Boolean)
									.join(" | ")
							: "No environment configured"}
					</CardDescription>
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
