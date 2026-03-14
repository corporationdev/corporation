import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@tendril/backend/convex/_generated/api";
import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { BoxIcon, ChevronDownIcon, FolderIcon, LaptopIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { usePersistedAgentModelSelection } from "@/hooks/use-persisted-agent-model-selection";
import { deriveAgentSelectorOptions } from "@/lib/agent-config-options";
import { usePendingMessageStore } from "@/stores/pending-message-store";

export const Route = createFileRoute("/_authenticated/")({
	component: AuthenticatedIndex,
});

type ProjectListItem = FunctionReturnType<typeof api.projects.list>[number];
type EnvironmentListItem = FunctionReturnType<
	typeof api.environments.list
>[number];

type BackingSelection =
	| { type: "sandbox" }
	| { type: "existing"; environmentId: Id<"environments"> };

const RECENT_PROJECT_STORAGE_KEY = "tendril:recent-project";
const SANDBOX_KEY = "sandbox";

function AuthenticatedIndex() {
	const navigate = useNavigate();
	const setMessage = usePendingMessageStore((s) => s.setMessage);
	const projects = useQuery(api.projects.list);
	const environments = useQuery(api.environments.list);
	const createSpace = useMutation(api.spaces.create);
	const agentConfigs = useQuery(api.agentConfig.list);
	const agentOptions = useMemo(
		() => deriveAgentSelectorOptions(agentConfigs),
		[agentConfigs]
	);
	const [input, setInput] = useState("");
	const { agent, modelId, setAgent, setModelId } =
		usePersistedAgentModelSelection(agentOptions);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [selectedProjectId, setSelectedProjectId] =
		useLocalStorage<Id<"projects"> | null>(RECENT_PROJECT_STORAGE_KEY, null);
	const [selectedEnvironmentKey, setSelectedEnvironmentKey] =
		useState(SANDBOX_KEY);

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

	// Reset to sandbox if selected environment disappears or disconnects
	useEffect(() => {
		if (selectedEnvironmentKey === SANDBOX_KEY) {
			return;
		}

		const env = (environments ?? []).find(
			(e) => e._id === selectedEnvironmentKey
		);
		if (!env || env.status !== "connected") {
			setSelectedEnvironmentKey(SANDBOX_KEY);
		}
	}, [environments, selectedEnvironmentKey]);

	const selectedProject = useMemo(() => {
		if (!(projects && selectedProjectId)) {
			return null;
		}
		return (
			projects.find((project) => project._id === selectedProjectId) ?? null
		);
	}, [projects, selectedProjectId]);

	const selectedBacking = useMemo<BackingSelection | null>(() => {
		if (selectedEnvironmentKey === SANDBOX_KEY) {
			return { type: "sandbox" };
		}

		const env = (environments ?? []).find(
			(e) => e._id === selectedEnvironmentKey && e.status === "connected"
		);
		return env ? { type: "existing", environmentId: env._id } : null;
	}, [environments, selectedEnvironmentKey]);

	const centerMessage =
		projects === undefined
			? "Loading projects..."
			: projects.length === 0
				? "Create a project to get started."
				: "How can I help you today?";
	const placeholder = selectedProject
		? "Send a message..."
		: "Select a project...";

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!(text && selectedProject && selectedBacking && agent && modelId)) {
			return;
		}

		setIsSubmitting(true);
		try {
			const spaceSlug = nanoid();
			const sessionId = nanoid();
			await createSpace({
				slug: spaceSlug,
				projectId: selectedProject._id,
				backing: selectedBacking,
			});

			setMessage({ text, agent, modelId });
			setInput("");

			navigate({
				to: "/space/$spaceSlug",
				params: { spaceSlug },
				search: { session: sessionId },
			});
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to create space"
			);
		} finally {
			setIsSubmitting(false);
		}
	}, [
		agent,
		createSpace,
		input,
		modelId,
		navigate,
		selectedBacking,
		selectedProject,
		setMessage,
	]);

	const isChatDisabled = !(
		selectedProject &&
		selectedBacking &&
		agent &&
		modelId &&
		!isSubmitting
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
								<EnvironmentSelector
									environments={environments ?? []}
									onSelectedKeyChange={setSelectedEnvironmentKey}
									selectedKey={selectedEnvironmentKey}
								/>
								<AgentModelPicker
									agent={agent}
									agentOptions={agentOptions}
									isLoading={agentConfigs === undefined}
									modelId={modelId}
									onAgentChange={setAgent}
									onModelIdChange={setModelId}
								/>
							</div>
						}
						message={input}
						onMessageChange={setInput}
						onSendMessage={handleSend}
						placeholder={isSubmitting ? "Creating space..." : placeholder}
					/>
				</div>
			</SidebarInset>
		</div>
	);
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

const EnvironmentSelector: FC<{
	environments: EnvironmentListItem[];
	selectedKey: string;
	onSelectedKeyChange: (key: string) => void;
}> = ({ environments, selectedKey, onSelectedKeyChange }) => {
	const selectedEnvironment =
		environments.find((environment) => environment._id === selectedKey) ?? null;
	const label =
		selectedKey === SANDBOX_KEY
			? "New sandbox"
			: (selectedEnvironment?.name ?? "Select environment");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex h-7 max-w-56 items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground">
				{selectedKey === SANDBOX_KEY ? (
					<BoxIcon className="size-3" />
				) : (
					<LaptopIcon className="size-3" />
				)}
				<span className="truncate">{label}</span>
				<ChevronDownIcon className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuItem onClick={() => onSelectedKeyChange(SANDBOX_KEY)}>
					<div className="flex items-center gap-2">
						<BoxIcon className="size-3.5" />
						<span>New sandbox</span>
					</div>
				</DropdownMenuItem>
				{environments.map((environment) => {
					const isConnected = environment.status === "connected";
					return (
						<DropdownMenuItem
							disabled={!isConnected}
							key={environment._id}
							onClick={() =>
								isConnected && onSelectedKeyChange(environment._id)
							}
						>
							<div className="flex items-center gap-2">
								<LaptopIcon className="size-3.5" />
								<span className="truncate">{environment.name}</span>
								{!isConnected && (
									<span className="ml-auto text-muted-foreground text-xs">
										offline
									</span>
								)}
							</div>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
