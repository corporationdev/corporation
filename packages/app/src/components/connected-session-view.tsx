import { useQueryClient } from "@tanstack/react-query";
import { api } from "@tendril/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSessionState } from "@/hooks/use-session-state";
import { createSpaceSession, sendSpaceMessage } from "@/lib/api-client";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import { AgentView, type ChatSendMessage } from "./chat/agent-view";

type ConsumedPending = {
	text: string;
	agent: string;
	modelId: string;
	modeId: string;
	reasoningEffort: string | null;
};

export const ConnectedSessionView: FC<{
	sessionId: string;
	spaceSlug: string;
}> = ({ sessionId, spaceSlug }) => {
	const queryClient = useQueryClient();
	const createSpace = useMutation(api.spaces.create);
	const [sessionReady, setSessionReady] = useState(false);
	const [pendingSend, setPendingSend] = useState<ConsumedPending | null>(null);

	const consumeMessage = usePendingMessageStore((s) => s.consumeMessage);
	const sessionState = useSessionState({
		sessionId,
		spaceSlug,
		streamEnabled: sessionReady,
	});

	// Reactively query space — will resolve once space is created
	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });
	const spaceId = space?._id;
	const backingData = useQuery(
		api.backings.getForSpace,
		spaceId ? { spaceId } : "skip"
	);
	const connectionId = backingData?.environment?.connectionId ?? null;
	const environmentId = backingData?.environment?._id;
	const projectId = space?.projectId;
	const projectEnvironment = useQuery(
		api.projectEnvironments.getByProjectAndEnvironment,
		projectId && environmentId ? { projectId, environmentId } : "skip"
	);
	const cwd = projectEnvironment?.path ?? null;

	// 1) On mount: consume pending message immediately, show optimistic, kick off space creation
	const hasConsumedRef = useRef(false);
	useEffect(() => {
		if (hasConsumedRef.current) {
			return;
		}
		hasConsumedRef.current = true;

		const pending = consumeMessage();
		if (!pending) {
			// No pending = existing session, just enable stream
			setSessionReady(true);
			return;
		}

		// Show optimistic message right away
		sessionState.addOptimisticMessage(pending.text);

		// Stash for the send effect
		setPendingSend({
			text: pending.text,
			agent: pending.agent,
			modelId: pending.modelId,
			modeId: pending.modeId,
			reasoningEffort: pending.reasoningEffort,
		});

		// Create space if needed
		if (pending.spaceCreation) {
			const { projectId: pid, backing } = pending.spaceCreation;
			createSpace({ slug: spaceSlug, projectId: pid, backing }).catch(
				(error: unknown) => {
					console.error("Failed to create space", error);
					sessionState.clearOptimisticMessages();
					toast.error(
						error instanceof Error ? error.message : "Failed to create space"
					);
				}
			);
		}
	}, [
		consumeMessage,
		createSpace,
		sessionState.addOptimisticMessage,
		sessionState.clearOptimisticMessages,
		spaceSlug,
	]);

	// 2) Once backing data is ready + we have a pending send: create session + send message
	useEffect(() => {
		if (!(pendingSend && connectionId && cwd)) {
			return;
		}

		const pending = pendingSend;
		setPendingSend(null);

		(async () => {
			await createSpaceSession(spaceSlug, {
				sessionId,
				clientId: connectionId,
				spaceName: spaceSlug,
				title: "New Chat",
				agent: pending.agent,
				cwd,
				model: pending.modelId,
				mode: pending.modeId,
				configOptions: pending.reasoningEffort
					? { reasoning_effort: pending.reasoningEffort }
					: undefined,
			});
			setSessionReady(true);
			await queryClient.invalidateQueries({
				queryKey: ["space-sessions", spaceSlug],
			});
			await sendSpaceMessage({
				spaceSlug,
				sessionId,
				content: pending.text,
				modelId: pending.modelId,
				mode: pending.modeId,
				configOptions: pending.reasoningEffort
					? { reasoning_effort: pending.reasoningEffort }
					: undefined,
			});
		})().catch((error: unknown) => {
			console.error("Failed to create session or send message", error);
			sessionState.clearOptimisticMessages();
			toast.error("Failed to send message");
		});
	}, [
		pendingSend,
		connectionId,
		cwd,
		queryClient,
		sessionId,
		spaceSlug,
		sessionState.clearOptimisticMessages,
	]);

	const handleSend: ChatSendMessage = useCallback(
		async (input) => {
			const text = input.message.trim();
			if (!text) {
				return;
			}

			sessionState.addOptimisticMessage(text);

			try {
				await sendSpaceMessage({
					spaceSlug,
					sessionId,
					content: text,
					modelId: input.modelId,
					mode: input.modeId,
					configOptions: input.reasoningEffort
						? { reasoning_effort: input.reasoningEffort }
						: undefined,
				});
			} catch (error) {
				console.error("Failed to send message", { error, sessionId });
				sessionState.clearOptimisticMessages();
				toast.error("Failed to send message");
			}
		},
		[
			sessionId,
			spaceSlug,
			sessionState.addOptimisticMessage,
			sessionState.clearOptimisticMessages,
		]
	);

	return (
		<AgentView
			error={sessionState.error}
			initialConfig={{
				agentId: sessionState.agent,
				modelId: sessionState.modelId,
			}}
			messages={sessionState.messages}
			sendMessage={handleSend}
			status={sessionState.status}
		/>
	);
};
