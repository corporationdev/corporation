"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import {
	AlertTriangleIcon,
	BotIcon,
	CpuIcon,
	MessageSquare,
} from "lucide-react";
import { useMemo, useState } from "react";
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
	PromptInputFooter,
	type PromptInputMessage,
	PromptInputSelect,
	PromptInputSelectContent,
	PromptInputSelectItem,
	PromptInputSelectTrigger,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import type { TendrilUIMessage } from "@/lib/tendril-ui-message";
import { cn } from "@/lib/utils";

type AgentConfigOption = {
	category: string;
	currentValue: string;
	description: string;
	id: string;
	name: string;
	options: Array<{
		description: string;
		name: string;
		value: string;
	}>;
	type: "select";
};

const AGENT_CONFIG_OPTIONS: Record<
	"claude-acp" | "codex-acp",
	AgentConfigOption[]
> = {
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
			description: "Choose an approval and sandboxing preset for your session",
			id: "mode",
			name: "Approval Preset",
			options: [
				{
					description:
						"Codex can read files in the current workspace. Approval is required to edit files or access the internet.",
					name: "Read Only",
					value: "read-only",
				},
				{
					description:
						"Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files. (Identical to Agent mode)",
					name: "Default",
					value: "auto",
				},
				{
					description:
						"Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.",
					name: "Full Access",
					value: "full-access",
				},
			],
			type: "select",
		},
		{
			category: "model",
			currentValue: "gpt-5.4",
			description: "Choose which model Codex should use",
			id: "model",
			name: "Model",
			options: [
				{
					description: "Latest frontier agentic coding model.",
					name: "gpt-5.4",
					value: "gpt-5.4",
				},
				{
					description: "Frontier Codex-optimized agentic coding model.",
					name: "gpt-5.3-codex",
					value: "gpt-5.3-codex",
				},
				{
					description: "Ultra-fast coding model.",
					name: "GPT-5.3-Codex-Spark",
					value: "gpt-5.3-codex-spark",
				},
				{
					description: "Frontier agentic coding model.",
					name: "gpt-5.2-codex",
					value: "gpt-5.2-codex",
				},
				{
					description:
						"Optimized for professional work and long-running agents",
					name: "gpt-5.2",
					value: "gpt-5.2",
				},
				{
					description: "Codex-optimized model for deep and fast reasoning.",
					name: "gpt-5.1-codex-max",
					value: "gpt-5.1-codex-max",
				},
				{
					description:
						"Optimized for codex. Cheaper, faster, but less capable.",
					name: "gpt-5.1-codex-mini",
					value: "gpt-5.1-codex-mini",
				},
			],
			type: "select",
		},
		{
			category: "thought_level",
			currentValue: "medium",
			description: "Choose how much reasoning effort the model should use",
			id: "reasoning_effort",
			name: "Reasoning Effort",
			options: [
				{
					description: "Fast responses with lighter reasoning",
					name: "Low",
					value: "low",
				},
				{
					description: "Balances speed and reasoning depth for everyday tasks",
					name: "Medium",
					value: "medium",
				},
				{
					description: "Greater reasoning depth for complex problems",
					name: "High",
					value: "high",
				},
				{
					description: "Extra high reasoning depth for complex problems",
					name: "Xhigh",
					value: "xhigh",
				},
			],
			type: "select",
		},
	],
};

const DEFAULT_AGENT_ID: keyof typeof AGENT_CONFIG_OPTIONS = "codex-acp";

const AGENT_LABELS: Record<keyof typeof AGENT_CONFIG_OPTIONS, string> = {
	"claude-acp": "Claude ACP",
	"codex-acp": "Codex ACP",
};

function getConfigOption(
	agentId: keyof typeof AGENT_CONFIG_OPTIONS,
	id: string
): AgentConfigOption | undefined {
	return AGENT_CONFIG_OPTIONS[agentId].find((option) => option.id === id);
}

export const AgentView = ({
	messages,
	sendMessage,
	status,
	error,
}: {
	messages: TendrilUIMessage[];
	sendMessage: UseChatHelpers<TendrilUIMessage>["sendMessage"];
	status: UseChatHelpers<TendrilUIMessage>["status"];
	error?: string | null;
}) => {
	const [input, setInput] = useState("");
	const [selectedAgentId, setSelectedAgentId] =
		useState<keyof typeof AGENT_CONFIG_OPTIONS>(DEFAULT_AGENT_ID);
	const [selectedModelId, setSelectedModelId] = useState(
		getConfigOption(DEFAULT_AGENT_ID, "model")?.currentValue ?? ""
	);
	const errorMessage = error?.trim() || "Unknown error";
	const modelOptions = useMemo(
		() => getConfigOption(selectedAgentId, "model")?.options ?? [],
		[selectedAgentId]
	);
	const selectedAgentLabel = AGENT_LABELS[selectedAgentId];
	const selectedModelLabel =
		modelOptions.find((option) => option.value === selectedModelId)?.name ??
		selectedModelId;

	const handleSubmit = (message: PromptInputMessage) => {
		if (message.text.trim()) {
			sendMessage({
				text: message.text,
				metadata: {
					composer: {
						agentId: selectedAgentId,
						modelId: selectedModelId,
					},
				},
			});
			setInput("");
		}
	};

	return (
		<div className="flex h-full flex-col">
			<Conversation>
				<ConversationContent>
					{status === "error" ? (
						<div className="mx-auto w-full max-w-[44rem] px-2 py-2">
							<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
								<AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
								<div className="min-w-0">
									<div className="font-medium">Run failed</div>
									<p className="break-words text-destructive/90">
										{errorMessage}
									</p>
								</div>
							</div>
						</div>
					) : null}
					{messages.length === 0 ? (
						<ConversationEmptyState
							description="Type a message below to begin chatting"
							icon={<MessageSquare className="size-12" />}
							title="Start a conversation"
						/>
					) : (
						messages.map((message) => (
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
						))
					)}
				</ConversationContent>
				<ConversationDownload messages={messages} />
				<ConversationScrollButton />
			</Conversation>

			<PromptInput
				className="relative mx-auto mt-4 w-full max-w-4xl rounded-[28px] border border-border/60 bg-card/80 p-1 shadow-sm backdrop-blur"
				onSubmit={handleSubmit}
			>
				<PromptInputBody>
					<PromptInputTextarea
						className="min-h-24 border-none bg-transparent px-4 pt-4 pr-4 text-base placeholder:text-foreground/40 focus-visible:ring-0"
						onChange={(e) => setInput(e.currentTarget.value)}
						placeholder="Ask Tendril anything"
						value={input}
					/>
				</PromptInputBody>
				<PromptInputFooter className="mt-1 px-2 pb-2">
					<PromptInputTools className="gap-2">
						<PromptInputSelect
							onValueChange={(value) => {
								const nextAgentId = value as keyof typeof AGENT_CONFIG_OPTIONS;
								setSelectedAgentId(nextAgentId);
								setSelectedModelId(
									getConfigOption(nextAgentId, "model")?.currentValue ?? ""
								);
							}}
							value={selectedAgentId}
						>
							<PromptInputSelectTrigger className="h-8 rounded-full border border-border/50 bg-background/60 px-3 font-medium text-foreground/80 text-xs hover:bg-muted/80">
								<BotIcon className="size-3.5 text-muted-foreground" />
								<span>{selectedAgentLabel}</span>
							</PromptInputSelectTrigger>
							<PromptInputSelectContent align="start">
								{(
									Object.entries(AGENT_LABELS) as Array<
										[keyof typeof AGENT_LABELS, string]
									>
								).map(([agentId, label]) => (
									<PromptInputSelectItem key={agentId} value={agentId}>
										<div className="flex min-w-0 flex-col">
											<span className="font-medium text-foreground">
												{label}
											</span>
											<span className="text-muted-foreground text-xs">
												{getConfigOption(agentId, "model")?.description}
											</span>
										</div>
									</PromptInputSelectItem>
								))}
							</PromptInputSelectContent>
						</PromptInputSelect>
						<PromptInputSelect
							onValueChange={setSelectedModelId}
							value={selectedModelId}
						>
							<PromptInputSelectTrigger className="h-8 rounded-full border border-border/50 bg-background/60 px-3 font-medium text-foreground/80 text-xs hover:bg-muted/80">
								<CpuIcon className="size-3.5 text-muted-foreground" />
								<span className="truncate">{selectedModelLabel}</span>
							</PromptInputSelectTrigger>
							<PromptInputSelectContent align="start">
								{modelOptions.map((option) => (
									<PromptInputSelectItem
										key={option.value}
										value={option.value}
									>
										<div className="flex min-w-0 flex-col">
											<span className="font-medium text-foreground">
												{option.name}
											</span>
											<span className="text-muted-foreground text-xs">
												{option.description}
											</span>
										</div>
									</PromptInputSelectItem>
								))}
							</PromptInputSelectContent>
						</PromptInputSelect>
					</PromptInputTools>
					<PromptInputSubmit
						className={cn(
							"size-9 rounded-full",
							(status === "streaming" || status === "submitted") &&
								"bg-foreground text-background hover:bg-foreground/90"
						)}
						disabled={!input.trim()}
						status={status}
					/>
				</PromptInputFooter>
			</PromptInput>
			<div className="flex gap-2">
				{" "}
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
			</div>
		</div>
	);
};
