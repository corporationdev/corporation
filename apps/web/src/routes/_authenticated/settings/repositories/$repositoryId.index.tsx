// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
	AlertTriangle,
	ArrowLeft,
	Hammer,
	Loader2,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	buildSecrets,
	RepositoryConfigForm,
	repositoryConfigSchema,
	secretsFromRecord,
} from "@/components/repository-config-form";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";
import { cn } from "@/lib/utils";

export const Route = createFileRoute(
	"/_authenticated/settings/repositories/$repositoryId/"
)({
	component: RepositoryDetailPage,
});

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

	return <RepositoryDetail repository={repository} />;
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

type Tab = "snapshots" | "secrets";

function RepositoryDetail({ repository }: { repository: Repository }) {
	const navigate = useNavigate();
	const [activeTab, setActiveTab] = useState<Tab>("snapshots");

	const { mutate: buildSnapshot, isPending: isSnapshotting } =
		useConvexTanstackMutation(api.snapshot.buildInitialSnapshot, {
			onError: (error) => {
				toast.error(error.message);
			},
		});

	const { mutate: removeRepository, isPending: isDeleting } =
		useConvexTanstackMutation(api.repositories.delete, {
			onSuccess: () => {
				toast.success("Repository deleted");
				navigate({ to: "/settings/repositories" });
			},
			onError: (error) => {
				toast.error(error.message);
			},
		});

	const isBuilding = repository.latestSnapshot?.status === "building";
	const isError = repository.latestSnapshot?.status === "error";

	return (
		<div className="flex flex-col gap-6 p-6">
			<div className="flex items-center justify-between">
				<div>
					<BackLink />
					<h1 className="mt-2 font-semibold text-lg">
						{repository.owner}/{repository.name}
					</h1>
					<StatusIndicator status={repository.latestSnapshot?.status ?? null} />
				</div>
				<div className="flex items-center gap-1">
					<Button
						disabled={isSnapshotting || isBuilding}
						onClick={() => buildSnapshot({ repositoryId: repository._id })}
						size="sm"
						variant="outline"
					>
						<Hammer className="size-4" />
						Build Snapshot
					</Button>
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

			<div>
				<div className="flex border-b">
					{(["snapshots", "secrets"] as Tab[]).map((tab) => (
						<button
							className={cn(
								"px-4 py-2 text-sm transition-colors",
								activeTab === tab
									? "border-foreground border-b-2 font-medium text-foreground"
									: "text-muted-foreground hover:text-foreground"
							)}
							key={tab}
							onClick={() => setActiveTab(tab)}
							type="button"
						>
							{tab.charAt(0).toUpperCase() + tab.slice(1)}
						</button>
					))}
				</div>

				<div className="mt-4">
					{activeTab === "snapshots" && (
						<SnapshotsTab isError={isError} repositoryId={repository._id} />
					)}
					{activeTab === "secrets" && <SecretsTab repository={repository} />}
				</div>
			</div>
		</div>
	);
}

function StatusIndicator({
	status,
}: {
	status: "building" | "ready" | "error" | null;
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

function SnapshotsTab({
	repositoryId,
	isError,
}: {
	repositoryId: Id<"repositories">;
	isError: boolean;
}) {
	return (
		<div className="flex flex-col gap-4">
			{isError && <LatestSnapshotError repositoryId={repositoryId} />}
			<SnapshotHistory repositoryId={repositoryId} />
		</div>
	);
}

function LatestSnapshotError({
	repositoryId,
}: {
	repositoryId: Id<"repositories">;
}) {
	const latestSnapshot = useQuery(api.snapshot.getLatest, { repositoryId });

	if (!latestSnapshot?.error) {
		return null;
	}

	return (
		<div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
			<AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
			<p className="whitespace-pre-wrap text-destructive text-sm">
				{latestSnapshot.error}
			</p>
		</div>
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
	repositoryId,
}: {
	repositoryId: Id<"repositories">;
}) {
	const snapshots = useQuery(api.snapshot.listByRepository, { repositoryId });

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
	ReturnType<typeof useQuery<typeof api.snapshot.listByRepository>>
>[number];

function SnapshotRow({ snapshot }: { snapshot: SnapshotSummary }) {
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
					<span className="font-medium">{snapshot.label}</span>
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
			</CardHeader>
		</Card>
	);
}

function SecretsTab({ repository }: { repository: Repository }) {
	const updateRepository = useMutation(api.repositories.update);

	const form = useForm({
		defaultValues: {
			secrets: secretsFromRecord(repository.secrets),
		},
		validators: {
			onSubmit: repositoryConfigSchema,
		},
		onSubmit: async ({ value }) => {
			await updateRepository({
				id: repository._id,
				secrets: buildSecrets(value.secrets),
			});
			toast.success("Secrets saved");
		},
	});

	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(e) => {
				e.preventDefault();
				form.handleSubmit();
			}}
		>
			<RepositoryConfigForm form={form} />
			<div className="flex justify-end">
				<form.Subscribe selector={(state) => state.isSubmitting}>
					{(isSubmitting) => (
						<Button disabled={isSubmitting} type="submit">
							{isSubmitting ? "Saving..." : "Save Changes"}
						</Button>
					)}
				</form.Subscribe>
			</div>
		</form>
	);
}
