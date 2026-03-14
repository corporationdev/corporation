// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft, LaptopIcon, Loader2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	buildSecretChanges,
	ProjectConfigForm,
	projectConfigSchema,
	secretsFromMetadata,
} from "@/components/project-config-form";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

type Tab = "snapshots" | "secrets" | "environments";

const TAB_LABELS: Record<Tab, string> = {
	snapshots: "Snapshots",
	secrets: "Secrets",
	environments: "Environments",
};

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
					{(["snapshots", "secrets", "environments"] as Tab[]).map((tab) => (
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
							{TAB_LABELS[tab]}
						</button>
					))}
				</div>

				<div className="mt-4">
					{activeTab === "snapshots" && <SnapshotList project={project} />}
					{activeTab === "secrets" && <SecretsTab project={project} />}
					{activeTab === "environments" && (
						<EnvironmentsTab projectId={project._id} />
					)}
				</div>
			</div>
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

function SnapshotList({ project }: { project: Project }) {
	const updateProject = useMutation(api.projects.update);

	return (
		<div className="flex flex-col gap-2">
			{project.snapshots.map((snapshot) => {
				const isDefault = snapshot._id === project.defaultSnapshotId;
				const statusDot =
					snapshot.status === "ready" ? (
						<span className="size-1.5 rounded-full bg-emerald-500" />
					) : snapshot.status === "error" ? (
						<span className="size-1.5 rounded-full bg-destructive" />
					) : (
						<Loader2 className="size-3 animate-spin text-muted-foreground" />
					);

				return (
					<Card key={snapshot._id} size="sm">
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
							<CardAction>
								{isDefault ? (
									<span className="rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground text-xs">
										Default
									</span>
								) : snapshot.status === "ready" ? (
									<Button
										onClick={() =>
											updateProject({
												id: project._id,
												defaultSnapshotId: snapshot._id,
											})
										}
										size="sm"
										type="button"
										variant="outline"
									>
										Make Default
									</Button>
								) : null}
							</CardAction>
						</CardHeader>
					</Card>
				);
			})}
		</div>
	);
}

function SecretsTab({ project }: { project: Project }) {
	const { mutate: updateSecrets, isPending } = useConvexTanstackMutation(
		api.projects.updateSecrets,
		{
			onSuccess: () => {
				toast.success("Environment variables updated");
			},
			onError: (error) => {
				toast.error(error.message);
			},
		}
	);
	const initialSecrets = useMemo(
		() => secretsFromMetadata(project.secrets),
		[project.secrets]
	);

	const form = useForm({
		defaultValues: {
			secrets: initialSecrets,
		},
		validators: {
			onSubmit: projectConfigSchema,
		},
		onSubmit: ({ value }) => {
			const changes = buildSecretChanges(initialSecrets, value.secrets);
			updateSecrets({
				id: project._id,
				upserts: changes.upserts,
				removeNames: changes.removeNames,
			});
		},
	});

	useEffect(() => {
		form.reset({
			secrets: initialSecrets,
		});
	}, [form, initialSecrets]);

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
				<Button disabled={isPending} type="submit">
					{isPending ? "Saving..." : "Save Changes"}
				</Button>
			</div>
		</form>
	);
}

type EnvironmentItem = FunctionReturnType<
	typeof api.environments.listPersistent
>[number];

type ProjectEnvironmentItem = FunctionReturnType<
	typeof api.projectEnvironments.listByProject
>[number];

function EnvironmentsTab({ projectId }: { projectId: Id<"projects"> }) {
	const environments = useQuery(api.environments.listPersistent);
	const projectEnvironments = useQuery(api.projectEnvironments.listByProject, {
		projectId,
	});
	const setProjectEnvironment = useMutation(api.projectEnvironments.set);

	if (environments === undefined || projectEnvironments === undefined) {
		return (
			<div className="flex flex-col gap-2">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}

	if (environments.length === 0) {
		return (
			<p className="py-4 text-muted-foreground text-sm">
				No environments found. Connect a CLI to create one.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{environments.map((env) => {
				const projectEnv = projectEnvironments.find(
					(pe) => pe.environmentId === env._id
				);
				return (
					<EnvironmentPathRow
						environment={env}
						key={env._id}
						onSave={(path) =>
							setProjectEnvironment({
								projectId,
								environmentId: env._id,
								path,
							})
						}
						projectEnvironment={projectEnv ?? null}
					/>
				);
			})}
		</div>
	);
}

function EnvironmentPathRow({
	environment,
	projectEnvironment,
	onSave,
}: {
	environment: EnvironmentItem;
	projectEnvironment: ProjectEnvironmentItem | null;
	onSave: (path: string) => void;
}) {
	const [value, setValue] = useState(projectEnvironment?.path ?? "");
	const [isDirty, setIsDirty] = useState(false);
	const prevPath = useRef(projectEnvironment?.path ?? "");

	useEffect(() => {
		const serverPath = projectEnvironment?.path ?? "";
		if (serverPath !== prevPath.current) {
			prevPath.current = serverPath;
			setValue(serverPath);
			setIsDirty(false);
		}
	}, [projectEnvironment?.path]);

	const handleChange = (newValue: string) => {
		setValue(newValue);
		setIsDirty(newValue.trim() !== (projectEnvironment?.path ?? ""));
	};

	const handleSave = () => {
		const trimmed = value.trim();
		if (!trimmed) {
			return;
		}
		onSave(trimmed);
		setIsDirty(false);
	};

	const isConnected = environment.status === "connected";

	return (
		<Card size="sm">
			<CardHeader className="py-3">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="font-medium text-sm">{environment.name}</span>
						<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
							<span
								className={cn(
									"size-1.5 rounded-full",
									isConnected ? "bg-emerald-500" : "bg-muted-foreground/50"
								)}
							/>
							{isConnected ? "Connected" : "Offline"}
						</span>
					</div>
				</div>
				<CardAction>
					<div className="flex items-center gap-2">
						<Input
							className="w-64"
							onChange={(e) => handleChange(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && isDirty) {
									handleSave();
								}
							}}
							placeholder="/path/to/project"
							value={value}
						/>
						{isDirty && (
							<Button onClick={handleSave} size="sm" variant="outline">
								Save
							</Button>
						)}
					</div>
				</CardAction>
			</CardHeader>
		</Card>
	);
}
