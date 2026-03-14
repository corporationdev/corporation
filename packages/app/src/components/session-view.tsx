import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { AlertTriangleIcon } from "lucide-react";
import { nanoid } from "nanoid";
import {
	type FC,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { AgentModelPicker } from "@/components/agent-model-picker";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import { usePersistedAgentModelSelection } from "@/hooks/use-persisted-agent-model-selection";
import { useSessionState } from "@/hooks/use-session-state";
import { deriveAgentSelectorOptions } from "@/lib/agent-config-options";
import {
	cancelSpaceSession,
	createSpaceSession,
	sendSpaceMessage,
} from "@/lib/api-client";
import { usePendingMessageStore } from "@/stores/pending-message-store";

type SessionViewSpace =
	| {
			_id: Id<"spaces">;
	  }
	| null
	| undefined;

export const SessionView: FC<{
	hasSession: boolean;
	sessionId?: string;
	space: SessionViewSpace;
	spaceSlug: string;
}> = ({ hasSession, sessionId, space, spaceSlug }) => {
	const agentConfigs = useQuery(api.agentConfig.list);
	const agentOptions = useMemo(
		() => deriveAgentSelectorOptions(agentConfigs),
		[agentConfigs]
	);

	if (sessionId) {
		return (
			<ConnectedSessionView
				agentOptions={agentOptions}
				hasSession={hasSession}
				key={sessionId}
				sessionId={sessionId}
				space={space}
				spaceSlug={spaceSlug}
			/>
		);
	}

	return (
		<NewSessionView
			agentOptions={agentOptions}
			isAgentOptionsLoading={agentConfigs === undefined}
			key={spaceSlug}
			spaceSlug={spaceSlug}
		/>
	);
};

const NewSessionView: FC<{
	spaceSlug: string;
	agentOptions: ReturnType<typeof deriveAgentSelectorOptions>;
	isAgentOptionsLoading: boolean;
}> = ({ spaceSlug, agentOptions, isAgentOptionsLoading }) => {
	const navigate = useNavigate();
	const setMessageStore = usePendingMessageStore((s) => s.setMessage);
	const [message, setMessage] = useState("");
	const { agent, modelId, setAgent, setModelId } =
		usePersistedAgentModelSelection(agentOptions);

	const handleSend = useCallback(() => {
		const text = message.trim();
		if (!(text && agent && modelId)) {
			return;
		}

		const sessionId = nanoid();

		setMessageStore({ text, agent, modelId });
		setMessage("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: { session: sessionId },
		});
	}, [message, agent, modelId, setMessageStore, spaceSlug, navigate]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<div className="flex flex-1 flex-col items-center justify-center px-4">
				<h1 className="font-semibold text-2xl">Hello there!</h1>
				<p className="mt-1 text-muted-foreground text-xl">
					How can I help you today?
				</p>
			</div>
			<ChatInput
				disabled={false}
				footer={
					<AgentModelPicker
						agent={agent}
						agentOptions={agentOptions}
						isLoading={isAgentOptionsLoading}
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

export const ConnectedSessionView: FC<{
	sessionId: string;
	spaceSlug: string;
	agentOptions: ReturnType<typeof deriveAgentSelectorOptions>;
	hasSession: boolean;
	space: SessionViewSpace;
}> = ({ sessionId, spaceSlug, agentOptions, hasSession, space }) => {
	const queryClient = useQueryClient();
	const [message, setMessage] = useState("");
	const [agentOverride, setAgentOverride] = useState<string | null>(null);
	const [modelIdOverride, setModelIdOverride] = useState<string | null>(null);
	const [hasCreatedSession, setHasCreatedSession] = useState(hasSession);

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const consumeMessage = usePendingMessageStore((s) => s.consumeMessage);
	const sessionState = useSessionState({
		sessionId,
		spaceSlug,
		streamEnabled: hasSession || hasCreatedSession,
	});
	const agent = agentOverride ?? sessionState.agent ?? "";
	const modelId = modelIdOverride ?? sessionState.modelId ?? "";
	const [pendingSend, setPendingSend] = useState<{
		text: string;
		agent: string;
		modelId: string;
	} | null>(null);
	const isRunning = sessionState.status === "running" && !pendingSend;
	const hasError = sessionState.status === "error" && !!sessionState.error;
	const hasConsumedStoredMessageRef = useRef(false);
	const spaceId = space?._id;

	const backingData = useQuery(
		api.backings.getForSpace,
		spaceId ? { spaceId } : "skip"
	);
	const connectionId = backingData?.environment?.connectionId ?? null;
	const runtimeReady =
		backingData?.environment?.status === "connected" && !!connectionId;
	const canFlushPendingSend = !!pendingSend && runtimeReady;

	const ensureRemoteSession = useCallback(
		async (nextAgent: string, nextModelId: string) => {
			if (hasSession || hasCreatedSession) {
				return;
			}
			if (!connectionId) {
				throw new Error("Runtime client is not ready");
			}

			await createSpaceSession(spaceSlug, {
				sessionId,
				clientId: connectionId,
				spaceName: spaceSlug,
				title: "New Chat",
				agent: nextAgent,
				cwd: "/workspace",
				model: nextModelId,
			});
			setHasCreatedSession(true);
			await queryClient.invalidateQueries({
				queryKey: ["space-sessions", spaceSlug],
			});
		},
		[
			hasCreatedSession,
			hasSession,
			queryClient,
			connectionId,
			sessionId,
			spaceSlug,
		]
	);

	useEffect(() => {
		if (hasSession) {
			setHasCreatedSession(true);
		}
	}, [hasSession]);

	// Consume pending message from store on mount
	useEffect(() => {
		if (hasConsumedStoredMessageRef.current) {
			return;
		}
		hasConsumedStoredMessageRef.current = true;
		const pending = consumeMessage();
		if (pending) {
			setPendingSend({ ...pending });
			setAgentOverride(pending.agent);
			setModelIdOverride(pending.modelId);
			sessionState.addOptimisticMessage(pending.text);
		}
	}, [consumeMessage, sessionState.addOptimisticMessage]);

	// Flush pending messages once the environment is connected.
	useEffect(() => {
		if (!canFlushPendingSend) {
			return;
		}
		const pending = pendingSend;
		if (!pending) {
			return;
		}

		setPendingSend(null);
		(async () => {
			await ensureRemoteSession(pending.agent, pending.modelId);
			await sendSpaceMessage({
				spaceSlug,
				sessionId,
				content: pending.text,
				modelId: pending.modelId,
			});
		})().catch((error: unknown) => {
			console.error("Failed to flush pending message", error);
			sessionState.clearOptimisticMessages();
			setHasCreatedSession(hasSession);
			setMessage((current) => (current ? current : pending.text));
			toast.error("Failed to send message");
		});
	}, [
		canFlushPendingSend,
		hasSession,
		pendingSend,
		ensureRemoteSession,
		sessionState.clearOptimisticMessages,
		sessionId,
		spaceSlug,
	]);

	const handleSend = useCallback(async () => {
		const text = message.trim();
		if (!text) {
			return;
		}

		setMessage("");
		sessionState.addOptimisticMessage(text);

		try {
			if (runtimeReady && connectionId) {
				await ensureRemoteSession(agent, modelId);
				await sendSpaceMessage({
					spaceSlug,
					sessionId,
					content: text,
					modelId,
				});
				return;
			}

			setPendingSend({ text, agent, modelId });
		} catch (error) {
			console.error("Failed to send message", { error, sessionId });
			setPendingSend(null);
			sessionState.clearOptimisticMessages();
			setMessage((current) => (current ? current : text));
			toast.error("Failed to send message");
		}
	}, [
		message,
		ensureRemoteSession,
		connectionId,
		runtimeReady,
		sessionId,
		agent,
		modelId,
		spaceSlug,
		sessionState.addOptimisticMessage,
		sessionState.clearOptimisticMessages,
	]);

	const handleStop = useCallback(async () => {
		try {
			await cancelSpaceSession({ spaceSlug, sessionId });
		} catch (error) {
			console.error("Failed to cancel session", { error, sessionId });
			toast.error("Failed to stop session");
		}
	}, [sessionId, spaceSlug]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally scroll when entries change
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [sessionState.entries, sessionState.error]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			{sessionState.entries.length === 0 && !hasError ? (
				<div className="flex flex-1 flex-col items-center justify-center px-4">
					<h1 className="font-semibold text-2xl">Ready to Chat</h1>
					<p className="mt-1 text-muted-foreground">
						Send a message to start a conversation.
					</p>
				</div>
			) : (
				<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					<ChatMessages
						entries={sessionState.entries}
						isThinking={isRunning}
						messagesEndRef={messagesEndRef}
					/>
					{hasError && (
						<div className="mx-auto w-full max-w-[44rem] px-2 py-2">
							<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
								<AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
								<div className="min-w-0">
									<div className="font-medium">Run failed</div>
									<p className="break-words text-destructive/90">
										{sessionState.error}
									</p>
								</div>
							</div>
						</div>
					)}
				</div>
			)}
			<ChatInput
				disabled={false}
				footer={
					<AgentModelPicker
						agent={agent}
						agentLocked
						agentOptions={agentOptions}
						modelId={modelId}
						modelLocked
						onAgentChange={setAgentOverride}
						onModelIdChange={setModelIdOverride}
					/>
				}
				isRunning={isRunning}
				message={message}
				onMessageChange={setMessage}
				onSendMessage={handleSend}
				onStop={handleStop}
				placeholder="Send a message..."
			/>
		</div>
	);
};
