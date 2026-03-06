import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArchiveIcon, BoxIcon } from "lucide-react";
import { type FC, useEffect, useMemo, useRef } from "react";

import { SpaceContextMenu } from "@/components/space-context-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLatestShas } from "@/hooks/use-latest-shas";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";

export const SpaceList: FC = () => {
	const groupedSpaces = useQuery(api.spaces.listByRepository);

	const repositoriesWithDefaultEnvironment =
		groupedSpaces
			?.filter((g) => g.defaultEnvironment)
			.map((g) => g.repository) ?? [];
	const { data: latestShas } = useLatestShas(
		repositoriesWithDefaultEnvironment,
		repositoriesWithDefaultEnvironment.length > 0
	);
	const spaces = useMemo(() => {
		if (!groupedSpaces) {
			return [];
		}
		return groupedSpaces
			.flatMap((group) =>
				group.spaces.map((space) => ({
					repository: group.repository,
					space,
				}))
			)
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
			{groupedSpaces.map((group) => (
				<RepositorySnapshotSync
					defaultEnvironment={group.defaultEnvironment}
					key={group.repository._id}
					latestSha={
						latestShas?.[`${group.repository.owner}/${group.repository.name}`]
					}
				/>
			))}
			{spaces.length === 0 ? (
				<NoSpacesState />
			) : (
				spaces.map(({ space }) => (
					<SpaceListItem
						branchName={space.branchName}
						id={space._id}
						key={space._id}
						slug={space.slug}
					/>
				))
			)}
		</div>
	);
};

type RepositorySpaceGroup = FunctionReturnType<
	typeof api.spaces.listByRepository
>[number];

const RepositorySnapshotSync: FC<{
	defaultEnvironment: RepositorySpaceGroup["defaultEnvironment"];
	latestSha: string | undefined;
}> = ({ defaultEnvironment, latestSha }) => {
	const snapshotCommitSha =
		defaultEnvironment?.activeSnapshot?.snapshotCommitSha;
	const snapshotStatus = defaultEnvironment?.latestSnapshot?.status;
	const isOutdated =
		!!latestSha && (!snapshotCommitSha || latestSha !== snapshotCommitSha);

	const { mutate: createSnapshot } = useConvexTanstackMutation(
		api.snapshot.createSnapshot
	);

	const lastTriggeredShaRef = useRef<Map<Id<"repositories">, string>>(
		new Map()
	);
	const repositoryId = defaultEnvironment?._id;

	useEffect(() => {
		if (
			!(repositoryId && isOutdated && latestSha) ||
			snapshotStatus === "building" ||
			lastTriggeredShaRef.current.get(repositoryId) === latestSha
		) {
			return;
		}

		createSnapshot(
			{
				request: {
					type: "update",
					repositoryId,
				},
			},
			{
				onSuccess: () => {
					lastTriggeredShaRef.current.set(repositoryId, latestSha);
				},
				onError: () => {
					// Failed rebuilds must not block retries for this repository + SHA.
					if (lastTriggeredShaRef.current.get(repositoryId) === latestSha) {
						lastTriggeredShaRef.current.delete(repositoryId);
					}
				},
			}
		);
	}, [repositoryId, isOutdated, latestSha, snapshotStatus, createSnapshot]);

	return null;
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

const NoSpacesState: FC = () => {
	const navigate = useNavigate();

	return (
		<div className="flex flex-col gap-2 px-2 py-3">
			<p className="text-muted-foreground text-xs">No spaces yet.</p>
			<Button
				className="h-8 justify-start px-2 text-xs"
				onClick={() => navigate({ to: "/" })}
				variant="outline"
			>
				Start a space
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
		<SpaceContextMenu
			branchName={branchName}
			isActive={isActive}
			slug={slug}
			spaceId={id}
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
		</SpaceContextMenu>
	);
};
