import type { UseChatHelpers } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@tendril/backend/convex/_generated/api";
import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { nanoid } from "nanoid";
import {
	type FC,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { useSessionState } from "@/hooks/use-session-state";
import { createSpaceSession, sendSpaceMessage } from "@/lib/api-client";
import type { TendrilUIMessage } from "@/lib/tendril-ui-message";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import { AgentView } from "./chat/agent-view";

type SessionViewSpace =
	| {
			_id: Id<"spaces">;
			projectId: Id<"projects">;
	  }
	| null
	| undefined;

const DEFAULT_AGENT_ID = "codex-acp";
const DEFAULT_MODEL_ID = "gpt-5.4";

export const SessionView: FC<{
	hasSession: boolean;
	sessionId?: string;
	space: SessionViewSpace;
	spaceSlug: string;
}> = ({ hasSession, sessionId, space, spaceSlug }) => {
	if (sessionId) {
		return (
			<ConnectedSessionView
				hasSession={hasSession}
				key={sessionId}
				sessionId={sessionId}
				space={space}
				spaceSlug={spaceSlug}
			/>
		);
	}

	return <NewSessionView key={spaceSlug} spaceSlug={spaceSlug} />;
};

const NewSessionView: FC<{
	spaceSlug: string;
}> = ({ spaceSlug }) => {
	const navigate = useNavigate();
	const setMessageStore = usePendingMessageStore((s) => s.setMessage);

	const handleSend: UseChatHelpers<TendrilUIMessage>["sendMessage"] =
		useCallback(
			(message) => {
				const text =
					message && "text" in message ? message.text?.trim() : undefined;
				const composer =
					message && "metadata" in message
						? message.metadata?.composer
						: undefined;
				const agent = composer?.agentId ?? DEFAULT_AGENT_ID;
				const modelId = composer?.modelId ?? DEFAULT_MODEL_ID;
				if (!(text && agent && modelId)) {
					return Promise.resolve();
				}

				const sessionId = nanoid();

				setMessageStore({ text, agent, modelId });

				navigate({
					to: "/space/$spaceSlug",
					params: { spaceSlug },
					search: { session: sessionId },
				});

				return Promise.resolve();
			},
			[setMessageStore, spaceSlug, navigate]
		);

	return <AgentView messages={[]} sendMessage={handleSend} status="ready" />;
};

export const ConnectedSessionView: FC<{
	sessionId: string;
	spaceSlug: string;
	hasSession: boolean;
	space: SessionViewSpace;
}> = ({ sessionId, spaceSlug, hasSession, space }) => {
	const queryClient = useQueryClient();
	const [agentOverride, setAgentOverride] = useState<string | null>(null);
	const [modelIdOverride, setModelIdOverride] = useState<string | null>(null);
	const [hasCreatedSession, setHasCreatedSession] = useState(hasSession);

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
	const hasError = sessionState.status === "error";
	const hasConsumedStoredMessageRef = useRef(false);
	const spaceId = space?._id;

	const backingData = useQuery(
		api.backings.getForSpace,
		spaceId ? { spaceId } : "skip"
	);
	const environmentId = backingData?.environment?._id;
	const connectionId = backingData?.environment?.connectionId ?? null;
	const isSandbox = backingData?.environment?.type === "sandbox";
	const runtimeReady =
		backingData?.environment?.status === "connected" && !!connectionId;

	const projectId = space?.projectId;
	const projectEnvironment = useQuery(
		api.projectEnvironments.getByProjectAndEnvironment,
		projectId && environmentId && !isSandbox
			? { projectId, environmentId }
			: "skip"
	);
	const cwd = isSandbox ? "/workspace" : (projectEnvironment?.path ?? null);
	const canFlushPendingSend = !!pendingSend && runtimeReady && !!cwd;

	const ensureRemoteSession = useCallback(
		async (nextAgent: string, nextModelId: string) => {
			if (hasSession || hasCreatedSession) {
				return;
			}
			if (!connectionId) {
				throw new Error("Runtime client is not ready");
			}
			if (!cwd) {
				throw new Error(
					"No path configured for this project on this environment"
				);
			}

			await createSpaceSession(spaceSlug, {
				sessionId,
				clientId: connectionId,
				spaceName: spaceSlug,
				title: "New Chat",
				agent: nextAgent,
				cwd,
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
			cwd,
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

	const handleSend: UseChatHelpers<TendrilUIMessage>["sendMessage"] =
		useCallback(
			async (message) => {
				const text =
					message && "text" in message ? message.text?.trim() : undefined;
				const composer =
					message && "metadata" in message
						? message.metadata?.composer
						: undefined;
				const nextAgent = composer?.agentId ?? agent ?? DEFAULT_AGENT_ID;
				const nextModelId = composer?.modelId ?? modelId ?? DEFAULT_MODEL_ID;
				if (!text) {
					return;
				}

				setAgentOverride(nextAgent);
				setModelIdOverride(nextModelId);
				sessionState.addOptimisticMessage(text);

				try {
					if (runtimeReady && connectionId) {
						await ensureRemoteSession(nextAgent, nextModelId);
						await sendSpaceMessage({
							spaceSlug,
							sessionId,
							content: text,
							modelId: nextModelId,
						});
						return;
					}

					setPendingSend({ text, agent: nextAgent, modelId: nextModelId });
				} catch (error) {
					console.error("Failed to send message", { error, sessionId });
					setPendingSend(null);
					sessionState.clearOptimisticMessages();
					toast.error("Failed to send message");
				}
			},
			[
				ensureRemoteSession,
				connectionId,
				runtimeReady,
				sessionId,
				agent,
				modelId,
				spaceSlug,
				sessionState.addOptimisticMessage,
				sessionState.clearOptimisticMessages,
			]
		);

	return (
		<AgentView
			error={sessionState.error}
			messages={sessionState.messages}
			sendMessage={handleSend}
			status={hasError ? "error" : isRunning ? "streaming" : "ready"}
		/>
	);
};
