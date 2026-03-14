import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "@tendril/backend/convex/_generated/api";
import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { Github, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/settings/projects/")({
	component: ProjectsPage,
});

function ProjectCard({
	project,
}: {
	project: {
		_id: Id<"projects">;
		name: string;
		githubOwner?: string;
		githubName?: string;
	};
}) {
	const isGitHubBacked = !!(project.githubOwner && project.githubName);

	return (
		<Link
			params={{ projectId: project._id }}
			to="/settings/projects/$projectId"
		>
			<Card size="sm">
				<CardHeader>
					<div className="flex items-center gap-3">
						<CardTitle>{project.name}</CardTitle>
						{isGitHubBacked ? (
							<span className="flex items-center gap-1 text-muted-foreground text-xs">
								<Github className="size-3" />
								{project.githubOwner}/{project.githubName}
							</span>
						) : (
							<span className="text-muted-foreground text-xs">No repo</span>
						)}
					</div>
				</CardHeader>
			</Card>
		</Link>
	);
}

function ProjectsPage() {
	const projects = useQuery(api.projects.list);
	const isLoading = projects === undefined;

	return (
		<div className="p-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="font-semibold text-lg">Projects</h1>
					<p className="mt-1 text-muted-foreground text-sm">
						Manage your projects and their configuration.
					</p>
				</div>
				<Link to="/settings/projects/new">
					<Button size="sm" variant="outline">
						<Plus className="size-4" />
						New Project
					</Button>
				</Link>
			</div>

			<div className="mt-4">
				{isLoading ? (
					<div className="flex flex-col gap-3">
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-16 w-full" />
					</div>
				) : projects.length ? (
					<div className="flex flex-col gap-3">
						{projects.map((project) => (
							<ProjectCard key={project._id} project={project} />
						))}
					</div>
				) : (
					<p className="text-muted-foreground text-sm">No projects yet.</p>
				)}
			</div>
		</div>
	);
}
