import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
	const repositories = useQuery(api.repositories.list);
	const [input, setInput] = useState("");
	const [agent, setAgent] = useState(INITIAL_AGENT);
	const [modelId, setModelId] = useState(INITIAL_MODEL);
	const [selectedRepositoryId, setSelectedRepositoryId] =
		useState<Id<"repositories"> | null>(null);

	useEffect(() => {
		if (!repositories) {
			return;
		}

		if (repositories.length === 0) {
			setSelectedRepositoryId(null);
			return;
		}

		setSelectedRepositoryId((current) => {
			if (
				current &&
				repositories.some((repository) => repository._id === current)
			) {
				return current;
			}

			const firstReadyRepository =
				repositories.find((repository) => repository.activeSnapshot) ??
				repositories[0];
			return firstReadyRepository?._id ?? null;
		});
	}, [repositories]);

	const selectedRepository = useMemo(() => {
		if (!(repositories && selectedRepositoryId)) {
			return null;
		}
		return (
			repositories.find(
				(repository) => repository._id === selectedRepositoryId
			) ?? null
		);
	}, [repositories, selectedRepositoryId]);

	const centerMessage =
		repositories === undefined
			? "Loading repositories..."
			: repositories.length === 0
				? "Connect a repository to get started."
				: "How can I help you today?";

	const handleSend = useCallback(() => {
		const text = input.trim();
		if (!(text && selectedRepository)) {
			return;
		}

		const spaceSlug = nanoid();
		const sessionId = nanoid();

		setSpace({ slug: spaceSlug, repositoryId: selectedRepository._id });
		setMessage({ text, agent, modelId });
		setInput("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: { session: sessionId },
		});
	}, [
		input,
		selectedRepository,
		agent,
		modelId,
		setSpace,
		setMessage,
		navigate,
	]);

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
						disabled={!selectedRepository}
						footer={
							<div className="flex items-center gap-2">
								<RepositorySelector
									onRepositoryIdChange={setSelectedRepositoryId}
									repositories={repositories ?? []}
									repositoryId={selectedRepositoryId}
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

type RepositoryListItem = FunctionReturnType<
	typeof api.repositories.list
>[number];

const RepositorySelector: FC<{
	repositories: RepositoryListItem[];
	repositoryId: Id<"repositories"> | null;
	onRepositoryIdChange: (repositoryId: Id<"repositories">) => void;
}> = ({ repositories, repositoryId, onRepositoryIdChange }) => {
	const selectedRepository =
		repositories.find((repository) => repository._id === repositoryId) ?? null;
	const label = selectedRepository
		? `${selectedRepository.owner}/${selectedRepository.name}`
		: "Select repository";
	const isDisabled = repositories.length === 0;

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
				{repositories.map((repository) => (
					<DropdownMenuItem
						key={repository._id}
						onClick={() => onRepositoryIdChange(repository._id)}
					>
						{repository.owner}/{repository.name}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
