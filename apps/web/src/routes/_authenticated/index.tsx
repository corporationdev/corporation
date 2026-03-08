import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
	ChevronDownIcon,
	ClockFadingIcon,
	FolderIcon,
	Loader2Icon,
} from "lucide-react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useEffect, useMemo, useState } from "react";
import { AgentModelPicker } from "@/components/agent-model-picker";
import { ChatInput } from "@/components/chat/chat-input";
import { SpaceListSidebar } from "@/components/space-list-sidebar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import agentModelsData from "@/data/agent-models.json";
import { usePendingMessageStore } from "@/stores/pending-message-store";

const INITIAL_AGENT = "claude";
const INITIAL_MODEL =
	agentModelsData[INITIAL_AGENT as keyof typeof agentModelsData].defaultModel ??
	"";

export const Route = createFileRoute("/_authenticated/")({
	component: AuthenticatedIndex,
});

function AuthenticatedIndex() {
	const navigate = useNavigate();
	const setSpace = usePendingMessageStore((s) => s.setSpace);
	const setMessage = usePendingMessageStore((s) => s.setMessage);
	const projects = useQuery(api.projects.list);
	const [selectedSnapshotId, setSelectedSnapshotId] =
		useState<Id<"snapshots"> | null>(null);
	const [input, setInput] = useState("");
	const [agent, setAgent] = useState(INITIAL_AGENT);
	const [modelId, setModelId] = useState(INITIAL_MODEL);
	const [selectedProjectId, setSelectedProjectId] =
		useLocalStorage<Id<"projects"> | null>("corporation:recent-project", null);

	useEffect(() => {
		if (!projects) {
			return;
		}

		if (projects.length === 0) {
			setSelectedProjectId(null);
			return;
		}

		setSelectedProjectId((current) => {
			if (current && projects.some((project) => project._id === current)) {
				return current;
			}

			return projects[0]?._id ?? null;
		});
	}, [projects, setSelectedProjectId]);

	const selectedProject = useMemo(() => {
		if (!(projects && selectedProjectId)) {
			return null;
		}
		return (
			projects.find((project) => project._id === selectedProjectId) ?? null
		);
	}, [projects, selectedProjectId]);
	const snapshots = useQuery(
		api.snapshot.listByProject,
		selectedProject ? { projectId: selectedProject._id } : "skip"
	);

	useEffect(() => {
		if (!selectedProject) {
			setSelectedSnapshotId(null);
			return;
		}
		if (snapshots === undefined) {
			return;
		}

		setSelectedSnapshotId((current) =>
			resolveSelectedSnapshotId({
				currentSnapshotId: current,
				defaultSnapshotId: selectedProject.defaultSnapshotId ?? null,
				snapshots,
			})
		);
	}, [selectedProject, snapshots]);

	const selectedSnapshot = useMemo(() => {
		if (!(snapshots && selectedSnapshotId)) {
			return null;
		}

		return (
			snapshots.find((snapshot) => snapshot._id === selectedSnapshotId) ?? null
		);
	}, [snapshots, selectedSnapshotId]);
	const isSelectedSnapshotReady = selectedSnapshot?.status === "ready";

	const centerMessage =
		projects === undefined
			? "Loading projects..."
			: projects.length === 0
				? "Create a project to get started."
				: "How can I help you today?";
	let placeholder = "Select a project...";
	if (selectedProject) {
		if (selectedSnapshot) {
			placeholder = isSelectedSnapshotReady
				? "Send a message..."
				: "Selected snapshot is not ready yet...";
		} else {
			placeholder =
				snapshots === undefined
					? "Loading snapshots..."
					: "Select a snapshot...";
		}
	}

	const handleSend = useCallback(() => {
		const text = input.trim();
		if (
			!(
				text &&
				selectedProject &&
				selectedSnapshotId &&
				isSelectedSnapshotReady
			)
		) {
			return;
		}

		const spaceSlug = nanoid();
		const sessionId = nanoid();

		setSpace({
			slug: spaceSlug,
			projectId: selectedProject._id,
			snapshotId: selectedSnapshotId,
		});
		setMessage({ text, agent, modelId });
		setInput("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: { session: sessionId },
		});
	}, [
		input,
		selectedProject,
		selectedSnapshotId,
		isSelectedSnapshotReady,
		agent,
		modelId,
		setSpace,
		setMessage,
		navigate,
	]);

	const isChatDisabled = !(
		selectedProject &&
		selectedSnapshotId &&
		isSelectedSnapshotReady
	);

	return (
		<div className="flex h-full w-full overflow-hidden">
			<SpaceListSidebar />
			<SidebarInset className="min-h-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
				</header>
				<div className="flex min-h-0 flex-1 flex-col bg-background">
					<div className="flex flex-1 flex-col items-center justify-center px-4">
						<h1 className="font-semibold text-2xl">Hello there!</h1>
						<p className="mt-1 text-muted-foreground text-xl">
							{centerMessage}
						</p>
					</div>
					<ChatInput
						disabled={isChatDisabled}
						footer={
							<div className="flex items-center gap-2">
								<ProjectSelector
									onProjectIdChange={setSelectedProjectId}
									projectId={selectedProjectId}
									projects={projects ?? []}
								/>
								<SnapshotSelector
									onSnapshotIdChange={setSelectedSnapshotId}
									project={selectedProject}
									snapshotId={selectedSnapshotId}
									snapshots={snapshots}
								/>
								<AgentModelPicker
									agent={agent}
									modelId={modelId}
									onAgentChange={setAgent}
									onModelIdChange={setModelId}
								/>
							</div>
						}
						message={input}
						onMessageChange={setInput}
						onSendMessage={handleSend}
						placeholder={placeholder}
					/>
				</div>
			</SidebarInset>
		</div>
	);
}

type ProjectListItem = FunctionReturnType<typeof api.projects.list>[number];
type SnapshotListItem = FunctionReturnType<
	typeof api.snapshot.listByProject
>[number];

function resolveSelectedSnapshotId({
	currentSnapshotId,
	defaultSnapshotId,
	snapshots,
}: {
	currentSnapshotId: Id<"snapshots"> | null;
	defaultSnapshotId: Id<"snapshots"> | null;
	snapshots: SnapshotListItem[];
}): Id<"snapshots"> | null {
	const readySnapshots = snapshots.filter(
		(snapshot) => snapshot.status === "ready"
	);

	if (
		currentSnapshotId &&
		readySnapshots.some((snapshot) => snapshot._id === currentSnapshotId)
	) {
		return currentSnapshotId;
	}

	if (
		defaultSnapshotId &&
		readySnapshots.some((snapshot) => snapshot._id === defaultSnapshotId)
	) {
		return defaultSnapshotId;
	}

	return readySnapshots[0]?._id ?? null;
}

const ProjectSelector: FC<{
	projects: ProjectListItem[];
	projectId: Id<"projects"> | null;
	onProjectIdChange: (projectId: Id<"projects">) => void;
}> = ({ projects, projectId, onProjectIdChange }) => {
	const selectedProject =
		projects.find((project) => project._id === projectId) ?? null;
	const label = selectedProject
		? selectedProject.githubOwner && selectedProject.githubName
			? `${selectedProject.githubOwner}/${selectedProject.githubName}`
			: selectedProject.name
		: "Select project";
	const isDisabled = projects.length === 0;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={`inline-flex h-7 max-w-56 items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground ${isDisabled ? "pointer-events-none opacity-50" : ""}`}
			>
				<FolderIcon className="size-3" />
				<span className="truncate">{label}</span>
				<ChevronDownIcon className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				{projects.map((project) => (
					<DropdownMenuItem
						key={project._id}
						onClick={() => onProjectIdChange(project._id)}
					>
						{project.githubOwner && project.githubName
							? `${project.githubOwner}/${project.githubName}`
							: project.name}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
};

const SnapshotSelector: FC<{
	project: ProjectListItem | null;
	snapshots: SnapshotListItem[] | undefined;
	snapshotId: Id<"snapshots"> | null;
	onSnapshotIdChange: (snapshotId: Id<"snapshots">) => void;
}> = ({ project, snapshots, snapshotId, onSnapshotIdChange }) => {
	const selectedSnapshot =
		snapshots?.find((snapshot) => snapshot._id === snapshotId) ?? null;
	const isLoading = !!project && snapshots === undefined;
	const hasReadySnapshots =
		snapshots?.some((snapshot) => snapshot.status === "ready") ?? false;
	const isDisabled = !project || isLoading || !hasReadySnapshots;
	const label = isLoading
		? "Loading snapshots..."
		: selectedSnapshot
			? selectedSnapshot.label
			: project
				? "Select snapshot"
				: "Select project first";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={`inline-flex h-7 max-w-56 items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground ${isDisabled ? "pointer-events-none opacity-50" : ""}`}
			>
				{isLoading ? (
					<Loader2Icon className="size-3 animate-spin" />
				) : (
					<ClockFadingIcon className="size-3" />
				)}
				<span className="truncate">{label}</span>
				<ChevronDownIcon className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				{snapshots?.map((snapshot) => (
					<DropdownMenuItem
						className={`flex items-center justify-between gap-3 ${snapshot._id === snapshotId ? "bg-accent text-accent-foreground" : ""}`}
						disabled={snapshot.status !== "ready"}
						key={snapshot._id}
						onClick={() => onSnapshotIdChange(snapshot._id)}
					>
						<span className="truncate">{snapshot.label}</span>
						{snapshot.status === "building" ? (
							<Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" />
						) : snapshot.status === "error" ? (
							<span className="size-2 shrink-0 rounded-full bg-destructive" />
						) : null}
					</DropdownMenuItem>
				))}
				{project && !isLoading && !hasReadySnapshots && (
					<DropdownMenuItem disabled>
						No ready snapshots available
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
