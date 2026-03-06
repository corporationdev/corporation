// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useRef, useState } from "react";
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
	const setSpace = usePendingMessageStore((s) => s.setSpace);
	const setMessage = usePendingMessageStore((s) => s.setMessage);
	const [input, setInput] = useState("");
	const [agent, setAgent] = useState(INITIAL_AGENT);
	const [modelId, setModelId] = useState(INITIAL_MODEL);
	const didRequestWarmRef = useRef(false);

	const repository = useQuery(api.repositories.get, { id: repositoryId });
	const defaultEnvironment = repository?.defaultEnvironment;
	const requestWarmSandbox = useMutation(api.warmSandboxes.request);

	const handleMessageChange = useCallback(
		(value: string) => {
			setInput(value);
			if (
				didRequestWarmRef.current ||
				!defaultEnvironment ||
				value.trim().length === 0
			) {
				return;
			}

			didRequestWarmRef.current = true;
			requestWarmSandbox({
				environmentId: defaultEnvironment._id,
				reason: "repository_typing",
			}).catch(() => undefined);
		},
		[defaultEnvironment, requestWarmSandbox]
	);

	const handleSend = useCallback(() => {
		const text = input.trim();
		if (!(text && defaultEnvironment)) {
			return;
		}

		const spaceSlug = nanoid();
		const sessionId = nanoid();

		setSpace({ slug: spaceSlug, environmentId: defaultEnvironment._id });
		setMessage({ text, agent, modelId });
		setInput("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: {
				tab: serializeTab({ type: "session", id: sessionId }),
			},
		});
	}, [
		input,
		defaultEnvironment,
		agent,
		modelId,
		setSpace,
		setMessage,
		navigate,
	]);

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
				message={input}
				onMessageChange={handleMessageChange}
				onSendMessage={handleSend}
				placeholder="Send a message..."
			/>
		</div>
	);
};
