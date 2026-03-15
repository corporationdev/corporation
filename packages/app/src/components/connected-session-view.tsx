import { type FC, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSessionState } from "@/hooks/use-session-state";
import { sendSpaceMessage } from "@/lib/api-client";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import { AgentView, type ChatSendMessage } from "./chat/agent-view";

export const ConnectedSessionView: FC<{
	sessionId: string;
	spaceSlug: string;
}> = ({ sessionId, spaceSlug }) => {
	const hasConsumedStoredMessageRef = useRef(false);
	const consumeMessage = usePendingMessageStore((s) => s.consumeMessage);

	const sessionState = useSessionState({
		sessionId,
		spaceSlug,
		streamEnabled: true,
	});

	// Consume pending message from store on mount and send it
	useEffect(() => {
		if (hasConsumedStoredMessageRef.current) {
			return;
		}
		hasConsumedStoredMessageRef.current = true;
		const pending = consumeMessage();
		if (pending) {
			sessionState.addOptimisticMessage(pending.text);
			sendSpaceMessage({
				spaceSlug,
				sessionId,
				content: pending.text,
				modelId: pending.modelId,
				mode: pending.modeId,
				configOptions: pending.reasoningEffort
					? { reasoning_effort: pending.reasoningEffort }
					: undefined,
			}).catch((error: unknown) => {
				console.error("Failed to send pending message", error);
				sessionState.clearOptimisticMessages();
				toast.error("Failed to send message");
			});
		}
	}, [
		consumeMessage,
		sessionState.addOptimisticMessage,
		sessionState.clearOptimisticMessages,
		sessionId,
		spaceSlug,
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
