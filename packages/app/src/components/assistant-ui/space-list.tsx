import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArchiveIcon, BoxIcon, FolderIcon, PlusIcon } from "lucide-react";
import { nanoid } from "nanoid";
import type { FC } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const SpaceList: FC = () => {
	const groupedSpaces = useQuery(api.spaces.listByRepository);

	if (groupedSpaces === undefined) {
		return (
			<div className="flex flex-col gap-1">
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
				<RepositorySpaceSection group={group} key={group.repository._id} />
			))}
		</div>
	);
};

type RepositorySpaceGroup = FunctionReturnType<
	typeof api.spaces.listByRepository
>[number];

const RepositorySpaceSection: FC<{
	group: RepositorySpaceGroup;
}> = ({ group }) => {
	const { repository, spaces, defaultEnvironmentId } = group;

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between gap-2 px-2 text-muted-foreground text-sm">
				<div className="flex min-w-0 items-center gap-2">
					<FolderIcon className="size-3.5 shrink-0" />
					<span className="truncate font-medium">
						{repository.owner}/{repository.name}
					</span>
				</div>
				{defaultEnvironmentId ? (
					<NewSpaceButton
						environmentId={defaultEnvironmentId}
						repositoryName={repository.name}
					/>
				) : null}
			</div>
			<div className="ml-2 flex flex-col gap-1 border-l pl-2">
				{spaces.length === 0 ? (
					<div className="px-2 py-1 text-muted-foreground text-xs">
						No spaces yet
					</div>
				) : (
					spaces.map((space) => (
						<SpaceListItem
							branchName={space.branchName}
							id={space._id}
							key={space._id}
							slug={space.slug}
						/>
					))
				)}
			</div>
		</div>
	);
};

const NewSpaceButton: FC<{
	environmentId: Id<"environments">;
	repositoryName: string;
}> = ({ environmentId, repositoryName }) => {
	const navigate = useNavigate();
	const ensureSpace = useMutation(api.spaces.ensure);

	const createSpaceMutation = useTanstackMutation({
		mutationFn: async () => {
			const spaceSlug = nanoid();
			await ensureSpace({
				slug: spaceSlug,
				environmentId,
			});

			return spaceSlug;
		},
		onSuccess: (spaceSlug) => {
			navigate({
				to: "/space/$spaceSlug",
				params: { spaceSlug },
			});
		},
		onError: () => {
			toast.error(`Failed to create a space in ${repositoryName}`);
		},
	});

	return (
		<Button
			className="size-6 rounded-sm p-0 hover:bg-muted"
			disabled={createSpaceMutation.isPending}
			onClick={() => createSpaceMutation.mutate()}
			size="icon"
			variant="outline"
		>
			<PlusIcon className="size-3.5" />
			<span className="sr-only">
				{createSpaceMutation.isPending
					? "Creating space..."
					: `New space in ${repositoryName}`}
			</span>
		</Button>
	);
};

const SpaceListSkeleton: FC = () => {
	const repositorySkeletonKeys = [
		"repo-skeleton-0",
		"repo-skeleton-1",
	] as const;
	const spaceSkeletonKeys = ["space-skeleton-0", "space-skeleton-1"] as const;

	return (
		<div className="flex flex-col gap-3">
			{repositorySkeletonKeys.map((repoKey) => (
				<div className="flex flex-col gap-1" key={repoKey}>
					<div className="flex h-6 items-center px-2">
						<Skeleton className="h-4 w-28" />
					</div>
					{spaceSkeletonKeys.map((spaceKey) => (
						<div className="flex h-9 items-center pl-4" key={spaceKey}>
							<Skeleton className="h-4 w-full" />
						</div>
					))}
				</div>
			))}
		</div>
	);
};

const NoRepositoriesState: FC = () => {
	const navigate = useNavigate();

	return (
		<div className="flex flex-col gap-2 px-2 py-3">
			<p className="text-muted-foreground text-xs">
				No repositories connected.
			</p>
			<Button
				className="h-8 justify-start px-2 text-xs"
				onClick={() => navigate({ to: "/settings/repositories/connect" })}
				variant="outline"
			>
				Connect Repository
			</Button>
		</div>
	);
};

const SpaceListItem: FC<{
	id: Id<"spaces">;
	slug: string;
	branchName: string;
}> = ({ id, slug, branchName }) => {
	const navigate = useNavigate();
	const match = useMatch({
		from: "/_authenticated/space/$spaceSlug",
		shouldThrow: false,
	});
	const isActive = match?.params.spaceSlug === slug;

	const archiveSpace = useMutation(api.spaces.archive);
	const archiveMutation = useTanstackMutation({
		mutationFn: () => archiveSpace({ id }),
		onSuccess: () => {
			if (isActive) {
				navigate({ to: "/space" });
			}
		},
	});

	return (
		<div
			className={cn(
				"group/item flex h-9 items-center gap-2 rounded-lg transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
				isActive && "bg-muted"
			)}
		>
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
				<span className="truncate">{branchName}</span>
			</button>
			<button
				className="mr-1 flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-accent group-hover/item:opacity-100"
				disabled={archiveMutation.isPending}
				onClick={() => archiveMutation.mutate()}
				type="button"
			>
				<ArchiveIcon className="size-3.5" />
			</button>
		</div>
	);
};
