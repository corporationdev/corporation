import type { UseChatHelpers } from "@ai-sdk/react";
import { api } from "@tendril/backend/convex/_generated/api";
import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import {
	ChevronDownIcon,
	MessageSquare,
	Monitor,
	PlusIcon,
	Shield,
} from "lucide-react";
import { useState } from "react";
import {
	Conversation,
	ConversationContent,
	ConversationDownload,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	PromptInput,
	PromptInputBody,
	PromptInputButton,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentModelPreferences } from "@/hooks/use-agent-model-preferences";
import { useEnvironmentSelection } from "@/hooks/use-environment-selection";
import type { TendrilUIMessage } from "@/lib/tendril-ui-message";

export type SpaceBacking =
	| { type: "sandbox" }
	| { type: "existing"; environmentId: Id<"environments"> };

export type ChatSendMessageInput = {
	message: string;
	agentId: string;
	modelId: string;
	modeId: string;
	backing: SpaceBacking;
};

export type ChatSendMessage = (message: ChatSendMessageInput) => Promise<void>;
export type ChatStatus = UseChatHelpers<TendrilUIMessage>["status"];

type ConfigOption = {
	description: string;
	name: string;
	value: string;
};

type ConfigItem = {
	category: string;
	currentValue: string;
	description: string;
	id: string;
	name: string;
	options: ConfigOption[];
	type: "select";
};

const AGENT_CONFIG: Record<string, ConfigItem[]> = {
	"claude-acp": [
		{
			category: "mode",
			currentValue: "bypassPermissions",
			description: "Session permission mode",
			id: "mode",
			name: "Mode",
			options: [
				{
					description: "Standard behavior, prompts for dangerous operations",
					name: "Default",
					value: "default",
				},
				{
					description: "Auto-accept file edit operations",
					name: "Accept Edits",
					value: "acceptEdits",
				},
				{
					description: "Planning mode, no actual tool execution",
					name: "Plan Mode",
					value: "plan",
				},
				{
					description: "Don't prompt for permissions, deny if not pre-approved",
					name: "Don't Ask",
					value: "dontAsk",
				},
				{
					description: "Bypass all permission checks",
					name: "Bypass Permissions",
					value: "bypassPermissions",
				},
			],
			type: "select",
		},
		{
			category: "model",
			currentValue: "default",
			description: "AI model to use",
			id: "model",
			name: "Model",
			options: [
				{
					description: "Opus 4.6 · Most capable for complex work",
					name: "Default (recommended)",
					value: "default",
				},
				{
					description: "Sonnet 4.6 · Best for everyday tasks",
					name: "Sonnet",
					value: "sonnet",
				},
				{
					description: "Haiku 4.5 · Fastest for quick answers",
					name: "Haiku",
					value: "haiku",
				},
			],
			type: "select",
		},
	],
};

const AGENT_LABELS: Record<string, string> = {
	"claude-acp": "Claude Agent",
};

const AGENTS = Object.keys(AGENT_CONFIG) as string[];
const MODELS_BY_AGENT = Object.fromEntries(
	(Object.entries(AGENT_CONFIG) as [string, ConfigItem[]][]).map(
		([agentId, config]) => {
			const modelConfig = config.find((c) => c.id === "model");
			const models = modelConfig?.options ?? [];
			return [
				agentId,
				models.map((o) => ({ id: o.value, name: o.name })),
			] as const;
		}
	)
);
const MODES_BY_AGENT = Object.fromEntries(
	(Object.entries(AGENT_CONFIG) as [string, ConfigItem[]][]).map(
		([agentId, config]) => {
			const modeConfig = config.find((c) => c.id === "mode");
			const modes = modeConfig?.options ?? [];
			return [
				agentId,
				modes.map((o) => ({ id: o.value, name: o.name })),
			] as const;
		}
	)
);

export const AgentView = ({
	messages,
	sendMessage,
	status,
	error,
	emptyState,
}: {
	messages: TendrilUIMessage[];
	sendMessage: ChatSendMessage;
	status: ChatStatus;
	error?: string | null;
	/** Optional empty state component when there are no messages. Defaults to ConversationEmptyState. */
	emptyState?: React.ReactNode;
}) => {
	const [message, setMessage] = useState("");
	const { agentId, modelId, modeId, setAgentId, setModelId, setModeId } =
		useAgentModelPreferences({ modesByAgent: MODES_BY_AGENT });
	const { environmentId, setEnvironmentId } = useEnvironmentSelection();

	const environments = useQuery(api.environments.listPersistent);

	const agents = AGENTS;
	const models = MODELS_BY_AGENT[agentId] ?? [];
	const modes = MODES_BY_AGENT[agentId] ?? [];
	const agentLabel = AGENT_LABELS[agentId] ?? agentId;
	const modelLabel = models.find((m) => m.id === modelId)?.name ?? modelId;
	const modeLabel = modes.find((m) => m.id === modeId)?.name ?? modeId;

	const environmentLabel =
		environmentId === "new-sandbox"
			? "New sandbox"
			: (environments?.find((e) => e._id === environmentId)?.name ??
				"Environment");

	const handleSubmit = () => {
		const input: ChatSendMessageInput = {
			message,
			agentId,
			modelId,
			modeId,
			backing:
				environmentId === "new-sandbox"
					? { type: "sandbox" }
					: { type: "existing", environmentId },
		};
		console.log("input", input);
		sendMessage(input);
		setMessage("");
	};

	const handleAgentChange = (id: string) => {
		if (id === agentId) {
			return;
		}
		setAgentId(id);
		const firstModel = MODELS_BY_AGENT[id]?.[0]?.id;
		if (firstModel) {
			setModelId(firstModel);
		}
	};

	return (
		<div className="flex h-full flex-col p-4">
			<Conversation>
				<ConversationContent>
					{messages.length === 0
						? (emptyState ?? (
								<ConversationEmptyState
									description="Type a message below to begin chatting"
									icon={<MessageSquare className="size-12" />}
									title="Start a conversation"
								/>
							))
						: messages.map((message) => (
								<Message from={message.role} key={message.id}>
									<MessageContent>
										{message.parts.map((part, i) => {
											switch (part.type) {
												case "text": // we don't use any reasoning or tool calls in this example
													return (
														<MessageResponse key={`${message.id}-${i}`}>
															{part.text}
														</MessageResponse>
													);
												default:
													return null;
											}
										})}
									</MessageContent>
								</Message>
							))}
				</ConversationContent>
				<ConversationDownload messages={messages} />
				<ConversationScrollButton />
			</Conversation>
			<p>{error}</p>
			<div className="mx-auto mt-4 w-full max-w-2xl">
				<PromptInput className="relative w-full" onSubmit={handleSubmit}>
					<PromptInputBody>
						<PromptInputTextarea
							className="px-4 py-3 pr-12"
							onChange={(e) => setMessage(e.currentTarget.value)}
							placeholder="Say something..."
							value={message}
						/>
					</PromptInputBody>

					<PromptInputFooter>
						<PromptInputTools>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={<PromptInputButton className="gap-1" />}
								>
									{agentLabel}
									<ChevronDownIcon className="size-3" />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start">
									{agents.map((id) => (
										<DropdownMenuItem
											key={id}
											onClick={() => handleAgentChange(id)}
										>
											{AGENT_LABELS[id] ?? id}
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<PromptInputButton className="min-w-0 max-w-32 gap-1" />
									}
								>
									<span className="truncate">{modelLabel}</span>
									<ChevronDownIcon className="size-3" />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start">
									{models.map((model) => (
										<DropdownMenuItem
											key={model.id}
											onClick={() => setModelId(model.id)}
										>
											{model.name ?? model.id}
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						</PromptInputTools>
						<PromptInputSubmit
							className="absolute right-1 bottom-1"
							disabled={!message.trim()}
							status={status}
						/>
					</PromptInputFooter>
				</PromptInput>
				<div className="mt-1.5 flex items-center justify-start gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<PromptInputButton className="h-6 gap-1.5 px-2 text-muted-foreground" />
							}
						>
							{environmentId === "new-sandbox" ? (
								<PlusIcon className="size-3.5 shrink-0" />
							) : (
								<Monitor className="size-3.5 shrink-0" />
							)}
							<span className="max-w-24 truncate">{environmentLabel}</span>
							<ChevronDownIcon className="size-3 shrink-0" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuItem onClick={() => setEnvironmentId("new-sandbox")}>
								<PlusIcon className="mr-2 size-3" />
								New sandbox
							</DropdownMenuItem>
							{environments?.map((env) => (
								<DropdownMenuItem
									key={env._id}
									onClick={() => setEnvironmentId(env._id)}
								>
									<Monitor className="mr-2 size-3" />
									{env.name}
								</DropdownMenuItem>
							)) ?? null}
						</DropdownMenuContent>
					</DropdownMenu>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<PromptInputButton className="h-6 min-w-0 max-w-28 gap-1.5 px-2 text-muted-foreground" />
							}
						>
							<Shield className="size-3.5 shrink-0" />
							<span className="truncate">{modeLabel}</span>
							<ChevronDownIcon className="size-3 shrink-0" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{modes.map((mode) => (
								<DropdownMenuItem
									key={mode.id}
									onClick={() => setModeId(mode.id)}
								>
									{mode.name ?? mode.id}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
		</div>
	);
};
