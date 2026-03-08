import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
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

	const centerMessage =
		projects === undefined
			? "Loading projects..."
			: projects.length === 0
				? "Create a project to get started."
				: "How can I help you today?";

	const handleSend = useCallback(() => {
		const text = input.trim();
		if (!(text && selectedProject)) {
			return;
		}

		const spaceSlug = nanoid();
		const sessionId = nanoid();

		setSpace({ slug: spaceSlug, projectId: selectedProject._id });
		setMessage({ text, agent, modelId });
		setInput("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: { session: sessionId },
		});
	}, [input, selectedProject, agent, modelId, setSpace, setMessage, navigate]);

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
						disabled={!selectedProject}
						footer={
							<div className="flex items-center gap-2">
								<ProjectSelector
									onProjectIdChange={setSelectedProjectId}
									projectId={selectedProjectId}
									projects={projects ?? []}
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
						placeholder="Send a message..."
					/>
				</div>
			</SidebarInset>
		</div>
	);
}

type ProjectListItem = FunctionReturnType<typeof api.projects.list>[number];

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
