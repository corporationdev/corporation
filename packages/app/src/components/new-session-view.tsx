import { useNavigate } from "@tanstack/react-router";
import { nanoid } from "nanoid";
import { type FC, useCallback, useMemo } from "react";
import { useSessionState } from "@/hooks/use-session-state";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import { AgentView, type ChatSendMessage } from "./chat/agent-view";

export const NewSessionView: FC<{
	spaceSlug: string;
}> = ({ spaceSlug }) => {
	const navigate = useNavigate();
	const setMessageStore = usePendingMessageStore((s) => s.setMessage);
	const sessionId = useMemo(() => nanoid(), []);

	const sessionState = useSessionState({
		sessionId,
		spaceSlug,
		streamEnabled: false,
	});

	const handleSend: ChatSendMessage = useCallback(
		(input) => {
			const text = input.message.trim();
			if (!text) {
				return Promise.resolve();
			}

			sessionState.addOptimisticMessage(text);

			setMessageStore({
				text,
				agent: input.agentId,
				modelId: input.modelId,
				modeId: input.modeId,
				reasoningEffort: input.reasoningEffort,
			});

			navigate({
				to: "/space/$spaceSlug",
				params: { spaceSlug },
				search: { session: sessionId },
			});

			return Promise.resolve();
		},
		[
			sessionId,
			sessionState.addOptimisticMessage,
			setMessageStore,
			spaceSlug,
			navigate,
		]
	);

	return (
		<AgentView
			messages={sessionState.messages}
			sendMessage={handleSend}
			status={sessionState.status}
		/>
	);
};
