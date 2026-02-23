import { api } from "@corporation/backend/convex/_generated/api";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { BoxIcon, PlusIcon } from "lucide-react";
import { nanoid } from "nanoid";
import type { FC } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const SpaceList: FC = () => {
	const spaces = useQuery(api.spaces.list);

	if (spaces === undefined) {
		return (
			<div className="flex flex-col gap-1">
				<NewSpaceButton />
				<SpaceListSkeleton />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1">
			<NewSpaceButton />
			{spaces.map((space) => (
				<SpaceListItem
					branchName={space.branchName}
					key={space._id}
					slug={space.slug}
					status={space.status}
				/>
			))}
		</div>
	);
};

const NewSpaceButton: FC = () => {
	const navigate = useNavigate();
	const ensureSpace = useMutation(api.spaces.ensure);
	const repositories = useQuery(api.repositories.list);
	const firstRepo = repositories?.[0];
	const environments = useQuery(
		api.environments.listByRepository,
		firstRepo ? { repositoryId: firstRepo._id } : "skip"
	);
	const firstEnv = environments?.[0];

	const createSpaceMutation = useTanstackMutation({
		mutationFn: async () => {
			if (!firstEnv) {
				throw new Error("No repository or environment configured");
			}

			const spaceSlug = nanoid();
			await ensureSpace({
				slug: spaceSlug,
				environmentId: firstEnv._id,
			});

			return spaceSlug;
		},
		onSuccess: (spaceSlug) => {
			navigate({
				to: "/space/$spaceSlug",
				params: { spaceSlug },
			});
		},
		onError: (error: unknown) => {
			console.error("Failed to create space", error);
		},
	});

	return (
		<Button
			className="h-9 justify-start gap-2 rounded-lg px-3 text-sm hover:bg-muted"
			disabled={createSpaceMutation.isPending}
			onClick={() => createSpaceMutation.mutate()}
			variant="outline"
		>
			<PlusIcon className="size-4" />
			{createSpaceMutation.isPending ? "Creating..." : "New Space"}
		</Button>
	);
};

const SpaceListSkeleton: FC = () => {
	const skeletonKeys = [
		"skeleton-0",
		"skeleton-1",
		"skeleton-2",
		"skeleton-3",
		"skeleton-4",
	] as const;

	return (
		<div className="flex flex-col gap-1">
			{skeletonKeys.map((key) => (
				<div className="flex h-9 items-center px-3" key={key}>
					<Skeleton className="h-4 w-full" />
				</div>
			))}
		</div>
	);
};

const SpaceListItem: FC<{
	slug: string;
	branchName: string;
	status: string;
}> = ({ slug, branchName, status }) => {
	const navigate = useNavigate();
	const match = useMatch({
		from: "/_authenticated/space/$spaceSlug",
		shouldThrow: false,
	});
	const isActive = match?.params.spaceSlug === slug;

	return (
		<div
			className={cn(
				"group flex h-9 items-center gap-2 rounded-lg transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
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
				<span className="ml-auto shrink-0 text-muted-foreground text-xs">
					{status}
				</span>
			</button>
		</div>
	);
};
