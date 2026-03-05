// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useState } from "react";
import { AgentModelPicker } from "@/components/agent-model-picker";
import { ChatInput } from "@/components/chat/chat-input";
import { SpaceListSidebar } from "@/components/space-list-sidebar";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import agentModelsData from "@/data/agent-models.json";
import { serializeTab } from "@/lib/tab-routing";
import { usePendingMessageStore } from "@/stores/pending-message-store";

const INITIAL_AGENT = "claude";
const INITIAL_MODEL =
	agentModelsData[INITIAL_AGENT as keyof typeof agentModelsData].defaultModel ??
	"";

export const Route = createFileRoute(
	"/_authenticated/repository/$repositoryId"
)({
	component: RepositoryRoute,
});

function RepositoryRoute() {
	const { repositoryId } = Route.useParams();
	return (
		<div className="flex h-full w-full overflow-hidden">
			<SpaceListSidebar />
			<SidebarInset className="min-h-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
				</header>
				<NewSpaceView repositoryId={repositoryId as Id<"repositories">} />
			</SidebarInset>
		</div>
	);
}

const NewSpaceView: FC<{
	repositoryId: Id<"repositories">;
}> = ({ repositoryId }) => {
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);
	const [message, setMessage] = useState("");
	const [agent, setAgent] = useState(INITIAL_AGENT);
	const [modelId, setModelId] = useState(INITIAL_MODEL);

	const repository = useQuery(api.repositories.get, { id: repositoryId });
	const defaultEnvironment = repository?.defaultEnvironment;

	const handleSend = useCallback(() => {
		const text = message.trim();
		if (!(text && defaultEnvironment)) {
			return;
		}

		const spaceSlug = nanoid();
		const sessionId = nanoid();

		setPending({ text, agent, modelId, environmentId: defaultEnvironment._id });
		setMessage("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: {
				tab: serializeTab({ type: "session", id: sessionId }),
			},
		});
	}, [message, defaultEnvironment, agent, modelId, setPending, navigate]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<div className="flex flex-1 flex-col items-center justify-center px-4">
				<h1 className="font-semibold text-2xl">Hello there!</h1>
				<p className="mt-1 text-muted-foreground text-xl">
					How can I help you today?
				</p>
			</div>
			<ChatInput
				disabled={!defaultEnvironment}
				footer={
					<AgentModelPicker
						agent={agent}
						modelId={modelId}
						onAgentChange={setAgent}
						onModelIdChange={setModelId}
					/>
				}
				message={message}
				onMessageChange={setMessage}
				onSendMessage={handleSend}
				placeholder="Send a message..."
			/>
		</div>
	);
};
