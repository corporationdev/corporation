// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import {
	AlertTriangle,
	ArrowLeft,
	ChevronDown,
	Hammer,
	Loader2,
	Pencil,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLatestShas } from "@/hooks/use-latest-shas";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";

export const Route = createFileRoute(
	"/_authenticated/settings/repositories/$repositoryId/"
)({
	component: RepositoryDetailPage,
});

const MS_PER_HOUR = 3_600_000;

function RepositoryDetailPage() {
	const { repositoryId } = Route.useParams();
	const repository = useQuery(api.repositories.get, {
		id: repositoryId as Id<"repositories">,
	});

	if (repository === undefined) {
		return (
			<div className="p-6">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="mt-4 h-48 w-full" />
			</div>
		);
	}

	if (!repository.defaultEnvironment) {
		return (
			<div className="p-6">
				<BackLink />
				<p className="mt-4 text-muted-foreground text-sm">
					No environment configured for this repository.
				</p>
			</div>
		);
	}

	return (
		<RepositoryDetail
			defaultEnvironment={repository.defaultEnvironment}
			repository={repository}
		/>
	);
}

function BackLink() {
	return (
		<Link
			className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
			to="/settings/repositories"
		>
			<ArrowLeft className="size-4" />
			Repositories
		</Link>
	);
}

type Repository = NonNullable<
	ReturnType<typeof useQuery<typeof api.repositories.get>>
>;
type Environment = NonNullable<Repository["defaultEnvironment"]>;

function RepositoryDetail({
	repository,
	defaultEnvironment,
}: {
	repository: Repository;
	defaultEnvironment: Environment;
}) {
	const { mutate: createSnapshot, isPending: isSnapshotting } =
		useConvexTanstackMutation(api.snapshot.createSnapshot, {
			onError: (error) => {
				toast.error(error.message);
			},
		});

	const { mutate: removeRepository, isPending: isDeleting } =
		useConvexTanstackMutation(api.repositories.delete, {
			onSuccess: () => {
				toast.success("Repository deleted");
			},
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

	const repos = useMemo(
		() => [
			{
				owner: repository.owner,
				name: repository.name,
				defaultBranch: repository.defaultBranch,
			},
		],
		[repository.owner, repository.name, repository.defaultBranch]
	);
	const { data: latestShas, isPending: shasPending } = useLatestShas(
		repos,
		true
	);
	const latestSha = latestShas?.[`${repository.owner}/${repository.name}`];
	const isOutdated =
		!!latestSha &&
		(!defaultEnvironment.snapshotCommitSha ||
			latestSha !== defaultEnvironment.snapshotCommitSha);

	const isBuilding = defaultEnvironment.snapshotStatus === "building";
	const isError = defaultEnvironment.snapshotStatus === "error";

	const currentHours = defaultEnvironment.rebuildIntervalMs
		? String(defaultEnvironment.rebuildIntervalMs / MS_PER_HOUR)
		: "0";

	return (
		<div className="flex flex-col gap-6 p-6">
			<div className="flex items-center justify-between">
				<div>
					<BackLink />
					<h1 className="mt-2 font-semibold text-lg">
						{repository.owner}/{repository.name}
					</h1>
					<StatusIndicator
						isChecking={shasPending}
						isOutdated={isOutdated}
						status={defaultEnvironment.snapshotStatus ?? null}
					/>
				</div>
				<div className="flex items-center gap-1">
					<Tooltip>
						<Button
							disabled={isSnapshotting || isBuilding}
							onClick={() =>
								createSnapshot({
									request: {
										type: "rebuild",
										environmentId: defaultEnvironment._id,
									},
								})
							}
							render={<TooltipTrigger />}
							size="sm"
							variant="outline"
						>
							<RefreshCw className="size-4" />
							Rebuild
						</Button>
						<TooltipContent>
							Incremental rebuild from current snapshot
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<Button
							disabled={isSnapshotting || isBuilding}
							onClick={() =>
								createSnapshot({
									request: {
										type: "build",
										environmentId: defaultEnvironment._id,
									},
								})
							}
							render={<TooltipTrigger />}
							size="sm"
							variant="outline"
						>
							<Hammer className="size-4" />
							Full Build
						</Button>
						<TooltipContent>Fresh build from scratch</TooltipContent>
					</Tooltip>
					<Link
						params={{ repositoryId: repository._id }}
						to="/settings/repositories/$repositoryId/edit"
					>
						<Button size="sm" variant="outline">
							<Pencil className="size-4" />
							Edit
						</Button>
					</Link>
					<Button
						disabled={isDeleting}
						onClick={() => removeRepository({ id: repository._id })}
						size="sm"
						variant="destructive"
					>
						<Trash2 className="size-4" />
						Delete
					</Button>
				</div>
			</div>

			{isError && (
				<ActiveSnapshotError environmentId={defaultEnvironment._id} />
			)}

			<ActiveSnapshotLogs
				environmentId={defaultEnvironment._id}
				isBuilding={isBuilding}
			/>

			<div className="flex items-center gap-2">
				<span className="text-muted-foreground text-sm">
					Auto-rebuild every
				</span>
				<Input
					className="h-8 w-20 text-sm"
					defaultValue={currentHours}
					key={currentHours}
					min={0}
					onBlur={(e) => {
						const hours = Number.parseFloat(e.target.value);
						const rebuildIntervalMs =
							Number.isNaN(hours) || hours <= 0
								? undefined
								: Math.round(hours * MS_PER_HOUR);
						setInterval({
							id: defaultEnvironment._id,
							rebuildIntervalMs,
						});
					}}
					step="any"
					type="number"
				/>
				<span className="text-muted-foreground text-sm">
					hours (0 to disable)
				</span>
			</div>

			<SnapshotHistory environmentId={defaultEnvironment._id} />
		</div>
	);
}

function StatusIndicator({
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
			<span className="mt-1 flex items-center gap-1.5 text-muted-foreground text-sm">
				<Loader2 className="size-3.5 animate-spin" />
				Building snapshot...
			</span>
		);
	}

	if (status === "ready" && isChecking) {
		return (
			<span className="mt-1 flex items-center gap-1.5 text-muted-foreground text-sm">
				<Loader2 className="size-3.5 animate-spin" />
				Checking...
			</span>
		);
	}

	if (status === "ready" && isOutdated) {
		return (
			<span className="mt-1 flex items-center gap-1.5 text-amber-600 text-sm">
				<span className="size-2 rounded-full bg-amber-500" />
				Out of date
			</span>
		);
	}

	if (status === "ready") {
		return (
			<span className="mt-1 flex items-center gap-1.5 text-emerald-600 text-sm">
				<span className="size-2 rounded-full bg-emerald-500" />
				Ready
			</span>
		);
	}

	return (
		<span className="mt-1 flex items-center gap-1.5 text-destructive text-sm">
			<span className="size-2 rounded-full bg-destructive" />
			Error
		</span>
	);
}

function ActiveSnapshotError({
	environmentId,
}: {
	environmentId: Id<"environments">;
}) {
	const activeSnapshot = useQuery(api.snapshot.getActive, { environmentId });

	if (!activeSnapshot?.error) {
		return null;
	}

	return (
		<div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
			<AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
			<p className="whitespace-pre-wrap break-words text-destructive text-sm">
				{activeSnapshot.error}
			</p>
		</div>
	);
}

function ActiveSnapshotLogs({
	environmentId,
	isBuilding,
}: {
	environmentId: Id<"environments">;
	isBuilding: boolean;
}) {
	const activeSnapshot = useQuery(api.snapshot.getActive, { environmentId });
	const [isOpen, setIsOpen] = useState(false);
	const logsEndRef = useRef<HTMLDivElement>(null);

	const hasLogs = !!activeSnapshot?.logs;

	useEffect(() => {
		if (isBuilding) {
			setIsOpen(true);
		}
	}, [isBuilding]);

	useEffect(() => {
		if (isBuilding && logsEndRef.current) {
			logsEndRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [isBuilding, activeSnapshot?.logs]);

	if (!hasLogs) {
		return null;
	}

	return (
		<Collapsible onOpenChange={setIsOpen} open={isOpen}>
			<CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
				<ChevronDown
					className={`size-4 transition-transform ${isOpen ? "" : "-rotate-90"}`}
				/>
				Build Logs
				{isBuilding && <Loader2 className="ml-1 size-3 animate-spin" />}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-4">
					<pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">
						{activeSnapshot.logs}
					</pre>
					{activeSnapshot.logsTruncated && (
						<p className="mt-2 text-muted-foreground text-xs italic">
							Logs truncated (exceeded maximum length)
						</p>
					)}
					<div ref={logsEndRef} />
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function formatDuration(startedAt: number, completedAt?: number): string {
	const end = completedAt ?? Date.now();
	const ms = end - startedAt;
	if (ms < 1000) {
		return "<1s";
	}
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) {
		return `${String(seconds)}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${String(minutes)}m ${String(remainingSeconds)}s`;
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function SnapshotHistory({
	environmentId,
}: {
	environmentId: Id<"environments">;
}) {
	const snapshots = useQuery(api.snapshot.listByEnvironment, {
		environmentId,
	});

	if (snapshots === undefined) {
		return <Skeleton className="h-32 w-full" />;
	}

	if (snapshots.length === 0) {
		return null;
	}

	return (
		<div>
			<h2 className="mb-3 font-medium text-sm">Build History</h2>
			<div className="flex flex-col gap-2">
				{snapshots.map((snapshot) => (
					<SnapshotRow key={snapshot._id} snapshot={snapshot} />
				))}
			</div>
		</div>
	);
}

type SnapshotSummary = NonNullable<
	ReturnType<typeof useQuery<typeof api.snapshot.listByEnvironment>>
>[number];

function SnapshotRow({ snapshot }: { snapshot: SnapshotSummary }) {
	const [expanded, setExpanded] = useState(false);

	const statusDot =
		snapshot.status === "ready" ? (
			<span className="size-1.5 rounded-full bg-emerald-500" />
		) : snapshot.status === "error" ? (
			<span className="size-1.5 rounded-full bg-destructive" />
		) : (
			<Loader2 className="size-3 animate-spin text-muted-foreground" />
		);

	return (
		<Card size="sm">
			<CardHeader className="py-2">
				<div className="flex items-center gap-3 text-sm">
					{statusDot}
					<span className="w-16 text-muted-foreground capitalize">
						{snapshot.type}
					</span>
					<span className="text-muted-foreground">
						{formatTime(snapshot.startedAt)}
					</span>
					<span className="text-muted-foreground">
						{formatDuration(snapshot.startedAt, snapshot.completedAt)}
					</span>
					{snapshot.error && (
						<span className="truncate text-destructive text-xs">
							{snapshot.error}
						</span>
					)}
				</div>
				{(snapshot.status === "ready" || snapshot.status === "error") && (
					<Button
						onClick={() => setExpanded(!expanded)}
						size="xs"
						variant="ghost"
					>
						<ChevronDown
							className={`size-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
						/>
						Logs
					</Button>
				)}
			</CardHeader>
			{expanded && <SnapshotLogs snapshotId={snapshot._id} />}
		</Card>
	);
}

function SnapshotLogs({ snapshotId }: { snapshotId: Id<"snapshots"> }) {
	const snapshot = useQuery(api.snapshot.get, { id: snapshotId });

	if (snapshot === undefined) {
		return (
			<CardContent>
				<Skeleton className="h-24 w-full" />
			</CardContent>
		);
	}

	if (!snapshot.logs) {
		return (
			<CardContent>
				<p className="text-muted-foreground text-xs">No logs available.</p>
			</CardContent>
		);
	}

	return (
		<CardContent>
			<div className="max-h-64 overflow-auto rounded-md bg-muted p-3">
				<pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">
					{snapshot.logs}
				</pre>
				{snapshot.logsTruncated && (
					<p className="mt-2 text-muted-foreground text-xs italic">
						Logs truncated (exceeded maximum length)
					</p>
				)}
			</div>
		</CardContent>
	);
}
