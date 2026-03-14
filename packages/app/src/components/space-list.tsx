import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArchiveIcon, FolderIcon, PlusIcon } from "lucide-react";
import type { FC } from "react";

import { SpaceContextMenu } from "@/components/space-context-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const RECENT_PROJECT_STORAGE_KEY = "corporation:recent-project";

type GroupedSpaceListItem = FunctionReturnType<
	typeof api.spaces.listByProject
>[number];

export const SpaceList: FC = () => {
	const groupedSpaces = useQuery(api.spaces.listByProject);
	const [, setSelectedProjectId] = useLocalStorage<Id<"projects"> | null>(
		RECENT_PROJECT_STORAGE_KEY,
		null
	);

	if (groupedSpaces === undefined) {
		return (
			<div className="flex flex-col gap-2">
				<SpaceListSkeleton />
			</div>
		);
	}

	if (groupedSpaces.length === 0) {
		return <NoRepositoriesState />;
	}

	return (
		<div className="flex flex-col gap-3">
			{groupedSpaces.map((group) => (
				<ProjectSpaceGroup
					group={group}
					key={group.project._id}
					onProjectSelect={setSelectedProjectId}
				/>
			))}
		</div>
	);
};

const SpaceListSkeleton: FC = () => {
	const spaceSkeletonKeys = [
		"repo-skeleton-0",
		"repo-skeleton-1",
		"repo-skeleton-2",
		"repo-skeleton-3",
	] as const;

	return (
		<div className="flex flex-col gap-1">
			{spaceSkeletonKeys.map((spaceKey) => (
				<div className="flex h-9 items-center px-2" key={spaceKey}>
					<Skeleton className="h-4 w-full" />
				</div>
			))}
		</div>
	);
};

const NoRepositoriesState: FC = () => {
	const navigate = useNavigate();

	return (
		<div className="flex flex-col gap-2 px-2 py-3">
			<p className="text-muted-foreground text-xs">No projects yet.</p>
			<Button
				className="h-8 justify-start px-2 text-xs"
				onClick={() => navigate({ to: "/settings/projects/new" })}
				variant="outline"
			>
				New Project
			</Button>
		</div>
	);
};

const ProjectSpaceGroup: FC<{
	group: GroupedSpaceListItem;
	onProjectSelect: (projectId: Id<"projects"> | null) => void;
}> = ({ group, onProjectSelect }) => {
	const navigate = useNavigate();
	const projectLabel = getProjectLabel(group.project);

	const handleCreateSpace = () => {
		onProjectSelect(group.project._id);
		navigate({ to: "/" });
	};

	return (
		<section className="flex flex-col gap-1">
			<div className="flex items-center gap-2 px-2">
				<div className="flex min-w-0 flex-1 items-center gap-2 py-1 text-muted-foreground text-xs">
					<FolderIcon className="size-3.5 shrink-0" />
					<span className="min-w-0 flex-1 truncate font-medium text-sm">
						{projectLabel}
					</span>
				</div>
				<button
					className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onClick={handleCreateSpace}
					type="button"
				>
					<PlusIcon className="size-3.5" />
					<span className="sr-only">Create a space in {projectLabel}</span>
				</button>
			</div>
			{group.spaces.map((space) => (
				<SpaceListItem
					id={space._id}
					key={space._id}
					name={space.name}
					projectId={group.project._id}
					setSelectedProjectId={onProjectSelect}
					slug={space.slug}
				/>
			))}
		</section>
	);
};

const SpaceListItem: FC<{
	id: Id<"spaces">;
	projectId: Id<"projects">;
	slug: string;
	name: string;
	setSelectedProjectId: (projectId: Id<"projects"> | null) => void;
}> = ({ id, projectId, slug, name, setSelectedProjectId }) => {
	const navigate = useNavigate();
	const match = useMatch({
		from: "/_authenticated/space_/$spaceSlug",
		shouldThrow: false,
	});
	const isActive = match?.params.spaceSlug === slug;

	const updateSpace = useMutation(api.spaces.update);
	const archiveMutation = useTanstackMutation({
		mutationFn: () => updateSpace({ id, archived: true }),
		onSuccess: () => {
			if (isActive) {
				navigate({ to: "/" });
			}
		},
	});

	return (
		<SpaceContextMenu isActive={isActive} name={name} slug={slug} spaceId={id}>
			<button
				className="flex h-full min-w-0 flex-1 items-center truncate px-8 text-start text-sm"
				onClick={() => {
					setSelectedProjectId(projectId);
					navigate({
						to: "/space/$spaceSlug",
						params: { spaceSlug: slug },
					});
				}}
				type="button"
			>
				<span className="truncate">{name}</span>
			</button>
			<button
				className="mr-1 flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-accent group-hover/item:opacity-100"
				disabled={archiveMutation.isPending}
				onClick={() => archiveMutation.mutate()}
				type="button"
			>
				<ArchiveIcon className="size-3.5" />
			</button>
		</SpaceContextMenu>
	);
};

function getProjectLabel(project: GroupedSpaceListItem["project"]) {
	return project.githubOwner && project.githubName
		? `${project.githubOwner}/${project.githubName}`
		: project.name;
}
