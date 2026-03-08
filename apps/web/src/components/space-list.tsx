import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ArchiveIcon, BoxIcon } from "lucide-react";
import { type FC, useMemo } from "react";

import { SpaceContextMenu } from "@/components/space-context-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const SpaceList: FC = () => {
	const groupedSpaces = useQuery(api.spaces.listByProject);

	const spaces = useMemo(() => {
		if (!groupedSpaces) {
			return [];
		}
		return groupedSpaces
			.flatMap((group) => group.spaces.map((space) => ({ space })))
			.sort((a, b) => b.space.updatedAt - a.space.updatedAt);
	}, [groupedSpaces]);

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
		<div className="flex flex-col gap-1">
			{spaces.length === 0 ? (
				<NoSpacesState />
			) : (
				spaces.map(({ space }) => (
					<SpaceListItem
						id={space._id}
						key={space._id}
						name={space.name}
						slug={space.slug}
					/>
				))
			)}
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

const NoSpacesState: FC = () => {
	return (
		<div className="px-2 py-3">
			<p className="text-muted-foreground text-xs">No spaces yet.</p>
		</div>
	);
};

const SpaceListItem: FC<{
	id: Id<"spaces">;
	slug: string;
	name: string;
}> = ({ id, slug, name }) => {
	const navigate = useNavigate();
	const match = useMatch({
		from: "/_authenticated/space_/$spaceSlug",
		shouldThrow: false,
	});
	const isActive = match?.params.spaceSlug === slug;

	const archiveSpace = useMutation(api.spaces.archive);
	const archiveMutation = useTanstackMutation({
		mutationFn: () => archiveSpace({ id }),
		onSuccess: () => {
			if (isActive) {
				navigate({ to: "/" });
			}
		},
	});

	return (
		<SpaceContextMenu isActive={isActive} name={name} slug={slug} spaceId={id}>
			<button
				className="flex h-full min-w-0 flex-1 items-center gap-2 truncate px-3 text-start text-sm"
				onClick={() =>
					navigate({
						to: "/space/$spaceSlug",
						params: { spaceSlug: slug },
					})
				}
				type="button"
			>
				<BoxIcon className="size-3.5 shrink-0" />
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
