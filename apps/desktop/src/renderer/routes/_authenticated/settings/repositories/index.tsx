import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

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
	};
}) {
	const removeRepository = useMutation(api.repositories.remove);
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
						{environment?.installCommand || environment?.devCommand
							? [environment.installCommand, environment.devCommand]
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
							onClick={() => removeRepository({ id: repository._id as never })}
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
