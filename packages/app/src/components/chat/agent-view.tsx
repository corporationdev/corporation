import type { UseChatHelpers } from "@ai-sdk/react";
import { api } from "@tendril/backend/convex/_generated/api";
import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import {
	BrainIcon,
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
	reasoningEffort: string | null;
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
	"codex-acp": [
		{
			category: "mode",
			currentValue: "auto",
			description: "Approval and sandboxing preset",
			id: "mode",
			name: "Approval Preset",
			options: [
				{
					description:
						"Read files only. Approval required for edits and internet access",
					name: "Read Only",
					value: "read-only",
				},
				{
					description:
						"Read/edit files, run commands. Approval for internet access",
					name: "Default",
					value: "auto",
				},
				{
					description: "Edit files and access the internet without approval",
					name: "Full Access",
					value: "full-access",
				},
			],
			type: "select",
		},
		{
			category: "model",
			currentValue: "gpt-5.4",
			description: "Model for Codex to use",
			id: "model",
			name: "Model",
			options: [
				{
					description: "Latest frontier agentic coding model",
					name: "gpt-5.4",
					value: "gpt-5.4",
				},
				{
					description: "Frontier Codex-optimized agentic coding model",
					name: "gpt-5.3-codex",
					value: "gpt-5.3-codex",
				},
				{
					description: "Ultra-fast coding model",
					name: "gpt-5.3-codex-spark",
					value: "gpt-5.3-codex-spark",
				},
				{
					description: "Frontier agentic coding model",
					name: "gpt-5.2-codex",
					value: "gpt-5.2-codex",
				},
				{
					description: "Optimized for long-running agents",
					name: "gpt-5.2",
					value: "gpt-5.2",
				},
				{
					description: "Deep and fast reasoning",
					name: "gpt-5.1-codex-max",
					value: "gpt-5.1-codex-max",
				},
				{
					description: "Cheaper, faster, less capable",
					name: "gpt-5.1-codex-mini",
					value: "gpt-5.1-codex-mini",
				},
			],
			type: "select",
		},
		{
			category: "thought_level",
			currentValue: "medium",
			description: "How much reasoning effort the model should use",
			id: "reasoning_effort",
			name: "Reasoning Effort",
			options: [
				{
					description: "Fast responses with lighter reasoning",
					name: "Low",
					value: "low",
				},
				{
					description: "Balances speed and reasoning depth",
					name: "Medium",
					value: "medium",
				},
				{
					description: "Greater reasoning depth for complex problems",
					name: "High",
					value: "high",
				},
				{
					description: "Extra high reasoning depth",
					name: "Xhigh",
					value: "xhigh",
				},
			],
			type: "select",
		},
	],
};

const AGENT_LABELS: Record<string, string> = {
	"claude-acp": "Claude Agent",
	"codex-acp": "Codex Agent",
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
const REASONING_EFFORTS_BY_AGENT = Object.fromEntries(
	(Object.entries(AGENT_CONFIG) as [string, ConfigItem[]][])
		.filter(([, config]) => config.some((c) => c.id === "reasoning_effort"))
		.map(([agentId, config]) => {
			const effortConfig = config.find((c) => c.id === "reasoning_effort");
			const efforts = effortConfig?.options ?? [];
			return [
				agentId,
				efforts.map((o) => ({ id: o.value, name: o.name })),
			] as const;
		})
);

export type AgentViewInitialConfig = {
	agentId?: string | null;
	modelId?: string | null;
};

export const AgentView = ({
	messages,
	sendMessage,
	status,
	error,
	emptyState,
	initialConfig,
}: {
	messages: TendrilUIMessage[];
	sendMessage: ChatSendMessage;
	status: ChatStatus;
	error?: string | null;
	/** Optional empty state component when there are no messages. Defaults to ConversationEmptyState. */
	emptyState?: React.ReactNode;
	/** Server-provided agent/model for existing sessions. Ephemeral override, not persisted. */
	initialConfig?: AgentViewInitialConfig;
}) => {
	const [message, setMessage] = useState("");

	// localStorage preferences — source of truth for new sessions
	const preferences = useAgentModelPreferences({
		modelsByAgent: MODELS_BY_AGENT,
		modesByAgent: MODES_BY_AGENT,
		reasoningEffortsByAgent: REASONING_EFFORTS_BY_AGENT,
	});

	// Ephemeral overrides seeded from server state (connected sessions)
	const [agentOverride, setAgentOverride] = useState<string | null>(
		initialConfig?.agentId ?? null
	);
	const [modelOverride, setModelOverride] = useState<string | null>(
		initialConfig?.modelId ?? null
	);

	// Use override if set, otherwise fall back to preferences
	const agentId = agentOverride ?? preferences.agentId;
	const modelId = modelOverride ?? preferences.modelId;
	const { modeId, reasoningEffort, setModeId, setReasoningEffort } =
		preferences;

	const setAgentId = initialConfig ? setAgentOverride : preferences.setAgentId;
	const setModelId = initialConfig ? setModelOverride : preferences.setModelId;

	const { environmentId, setEnvironmentId } = useEnvironmentSelection();

	const environments = useQuery(api.environments.listPersistent);

	const agents = AGENTS;
	const models = MODELS_BY_AGENT[agentId] ?? [];
	const modes = MODES_BY_AGENT[agentId] ?? [];
	const reasoningEfforts = REASONING_EFFORTS_BY_AGENT[agentId] ?? [];
	const agentLabel = AGENT_LABELS[agentId] ?? agentId;
	const modelLabel = models.find((m) => m.id === modelId)?.name ?? modelId;
	const modeLabel = modes.find((m) => m.id === modeId)?.name ?? modeId;
	const reasoningEffortLabel =
		reasoningEfforts.find((r) => r.id === reasoningEffort)?.name ??
		reasoningEffort;

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
			reasoningEffort,
			backing:
				environmentId === "new-sandbox"
					? { type: "sandbox" }
					: { type: "existing", environmentId },
		};
		sendMessage(input);
		setMessage("");
	};

	const handleAgentChange = (id: string) => {
		if (id !== agentId) {
			setAgentId(id);
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
							{reasoningEfforts.length > 0 && reasoningEffortLabel && (
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<PromptInputButton className="min-w-0 max-w-28 gap-1" />
										}
									>
										<BrainIcon className="size-3.5 shrink-0" />
										<span className="truncate">{reasoningEffortLabel}</span>
										<ChevronDownIcon className="size-3" />
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start">
										{reasoningEfforts.map((effort) => (
											<DropdownMenuItem
												key={effort.id}
												onClick={() => setReasoningEffort(effort.id)}
											>
												{effort.name ?? effort.id}
											</DropdownMenuItem>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
							)}
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
