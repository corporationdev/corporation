import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Hammer, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLatestShas } from "@/hooks/use-latest-shas";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";

export const Route = createFileRoute("/_authenticated/settings/repositories/")({
	component: RepositoriesPage,
});

const MS_PER_HOUR = 3_600_000;

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
			rebuildIntervalMs?: number;
		} | null;
	};
	isOutdated: boolean;
	isChecking: boolean;
}) {
	const { mutate: removeRepository, isPending: isDeleting } =
		useConvexTanstackMutation(api.repositories.delete, {
			onError: (error) => {
				toast.error(error.message);
			},
		});

	const { mutate: createSnapshot, isPending: isSnapshotting } =
		useConvexTanstackMutation(api.environments.createSnapshot, {
			onError: (error) => {
				toast.error(error.message);
			},
		});

	const { mutate: setInterval } = useConvexTanstackMutation(
		api.environments.updateRebuildInterval,
		{
			onError: (error) => {
				toast.error(error.message);
			},
		}
	);

	const currentHours = repository.defaultEnvironment?.rebuildIntervalMs
		? String(repository.defaultEnvironment.rebuildIntervalMs / MS_PER_HOUR)
		: "0";

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
						{repository.defaultEnvironment ? (
							<>
								<Tooltip>
									<Button
										disabled={
											isSnapshotting ||
											repository.defaultEnvironment.snapshotStatus ===
												"building"
										}
										onClick={() => {
											if (repository.defaultEnvironment) {
												createSnapshot({
													type: "rebuild",
													environmentId: repository.defaultEnvironment._id,
												});
											}
										}}
										render={<TooltipTrigger />}
										size="icon-sm"
										variant="ghost"
									>
										<RefreshCw className="size-4" />
									</Button>
									<TooltipContent>Rebuild snapshot</TooltipContent>
								</Tooltip>
								<Tooltip>
									<Button
										disabled={
											isSnapshotting ||
											repository.defaultEnvironment.snapshotStatus ===
												"building"
										}
										onClick={() => {
											if (repository.defaultEnvironment) {
												createSnapshot({
													type: "build",
													environmentId: repository.defaultEnvironment._id,
												});
											}
										}}
										render={<TooltipTrigger />}
										size="icon-sm"
										variant="ghost"
									>
										<Hammer className="size-4" />
									</Button>
									<TooltipContent>Build snapshot</TooltipContent>
								</Tooltip>
							</>
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
							onClick={() => removeRepository({ id: repository._id })}
							size="icon-sm"
							variant="ghost"
						>
							<Trash2 className="size-4" />
						</Button>
					</div>
				</CardAction>
			</CardHeader>
			{repository.defaultEnvironment && (
				<CardContent>
					<div className="flex items-center gap-2">
						<span className="text-muted-foreground text-xs">
							Auto-rebuild every
						</span>
						<Input
							className="h-7 w-16 text-xs"
							defaultValue={currentHours}
							min={0}
							onBlur={(e) => {
								if (!repository.defaultEnvironment) {
									return;
								}
								const hours = Number.parseFloat(e.target.value);
								const rebuildIntervalMs =
									Number.isNaN(hours) || hours <= 0
										? undefined
										: Math.round(hours * MS_PER_HOUR);
								setInterval({
									id: repository.defaultEnvironment._id,
									rebuildIntervalMs,
								});
							}}
							step="any"
							type="number"
						/>
						<span className="text-muted-foreground text-xs">
							hours (0 to disable)
						</span>
					</div>
				</CardContent>
			)}
		</Card>
	);
}

function RepositoriesPage() {
	const repositories = useQuery(api.repositories.list);
	const isLoading = repositories === undefined;

	const repos = useMemo(
		() =>
			(repositories ?? []).map((r) => ({
				owner: r.owner,
				name: r.name,
				defaultBranch: r.defaultBranch,
			})),
		[repositories]
	);
	const { data: latestShas, isPending: shasPending } = useLatestShas(
		repos,
		!!repositories?.length
	);

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
