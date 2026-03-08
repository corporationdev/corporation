// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";

import { useState } from "react";
import { toast } from "sonner";
import {
	buildSecrets,
	ProjectConfigForm,
	projectConfigSchema,
	secretsFromRecord,
} from "@/components/project-config-form";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";
import { cn } from "@/lib/utils";

export const Route = createFileRoute(
	"/_authenticated/settings/projects/$projectId/"
)({
	component: ProjectDetailPage,
});

function ProjectDetailPage() {
	const { projectId } = Route.useParams();
	const project = useQuery(api.projects.get, {
		id: projectId as Id<"projects">,
	});

	if (project === undefined) {
		return (
			<div className="p-6">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="mt-4 h-48 w-full" />
			</div>
		);
	}

	return <ProjectDetail project={project} />;
}

function BackLink() {
	return (
		<Link
			className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
			to="/settings/projects"
		>
			<ArrowLeft className="size-4" />
			Projects
		</Link>
	);
}

type Project = NonNullable<
	ReturnType<typeof useQuery<typeof api.projects.get>>
>;

type Tab = "snapshots" | "settings";

function ProjectDetail({ project }: { project: Project }) {
	const navigate = useNavigate();
	const [activeTab, setActiveTab] = useState<Tab>("snapshots");

	const { mutate: removeProject, isPending: isDeleting } =
		useConvexTanstackMutation(api.projects.delete, {
			onSuccess: () => {
				toast.success("Project deleted");
				navigate({ to: "/settings/projects" });
			},
			onError: (error) => {
				toast.error(error.message);
			},
		});

	return (
		<div className="flex flex-col gap-6 p-6">
			<div className="flex items-center justify-between">
				<div>
					<BackLink />
					<h1 className="mt-2 font-semibold text-lg">{project.name}</h1>
					{project.githubOwner && project.githubName && (
						<p className="text-muted-foreground text-sm">
							{project.githubOwner}/{project.githubName}
						</p>
					)}
				</div>
				<div className="flex items-center gap-1">
					<Button
						disabled={isDeleting}
						onClick={() => removeProject({ id: project._id })}
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
					{(["snapshots", "settings"] as Tab[]).map((tab) => (
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
						<SnapshotsTab projectId={project._id} />
					)}
					{activeTab === "settings" && <SettingsTab project={project} />}
				</div>
			</div>
		</div>
	);
}

function SnapshotsTab({ projectId }: { projectId: Id<"projects"> }) {
	return (
		<div className="flex flex-col gap-4">
			<SnapshotHistory projectId={projectId} />
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

function SnapshotHistory({ projectId }: { projectId: Id<"projects"> }) {
	const snapshots = useQuery(api.snapshot.listByProject, { projectId });

	if (snapshots === undefined) {
		return <Skeleton className="h-32 w-full" />;
	}

	if (snapshots.length === 0) {
		return null;
	}

	return (
		<div>
			<div className="flex flex-col gap-2">
				{snapshots.map((snapshot) => (
					<SnapshotRow key={snapshot._id} snapshot={snapshot} />
				))}
			</div>
		</div>
	);
}

type SnapshotSummary = NonNullable<
	ReturnType<typeof useQuery<typeof api.snapshot.listByProject>>
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

function SettingsTab({ project }: { project: Project }) {
	const updateProject = useMutation(api.projects.update);

	const form = useForm({
		defaultValues: {
			secrets: secretsFromRecord(project.secrets),
		},
		validators: {
			onSubmit: projectConfigSchema,
		},
		onSubmit: async ({ value }) => {
			await updateProject({
				id: project._id,
				secrets: buildSecrets(value.secrets),
			});
			toast.success("Settings saved");
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
			<ProjectConfigForm form={form} />
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
