import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@tendril/backend/convex/_generated/api";
import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useState } from "react";
import { toast } from "sonner";
import { createSpaceSession } from "@/lib/api-client";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import { AgentView, type ChatSendMessage } from "./chat/agent-view";

export const NewSessionView: FC<{
	spaceSlug: string;
	space: { _id: Id<"spaces">; projectId: Id<"projects"> } | null | undefined;
}> = ({ spaceSlug, space }) => {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const setMessageStore = usePendingMessageStore((s) => s.setMessage);
	const [isSubmitting, setIsSubmitting] = useState(false);

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

	const handleSend: ChatSendMessage = useCallback(
		async (input) => {
			const text = input.message.trim();
			if (!text || isSubmitting) {
				return;
			}

			if (!connectionId) {
				toast.error("Environment is not connected");
				return;
			}
			if (!cwd) {
				toast.error("No path configured for this project");
				return;
			}

			setIsSubmitting(true);
			try {
				const sessionId = nanoid();

				await createSpaceSession(spaceSlug, {
					sessionId,
					clientId: connectionId,
					spaceName: spaceSlug,
					title: "New Chat",
					agent: input.agentId,
					cwd,
					model: input.modelId,
					mode: input.modeId,
					configOptions: input.reasoningEffort
						? { reasoning_effort: input.reasoningEffort }
						: undefined,
				});

				setMessageStore({
					text,
					agent: input.agentId,
					modelId: input.modelId,
					modeId: input.modeId,
					reasoningEffort: input.reasoningEffort,
				});

				await queryClient.invalidateQueries({
					queryKey: ["space-sessions", spaceSlug],
				});

				navigate({
					to: "/space/$spaceSlug",
					params: { spaceSlug },
					search: { session: sessionId },
				});
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to create session"
				);
			} finally {
				setIsSubmitting(false);
			}
		},
		[
			connectionId,
			cwd,
			isSubmitting,
			navigate,
			queryClient,
			setMessageStore,
			spaceSlug,
		]
	);

	return (
		<AgentView
			messages={[]}
			sendMessage={handleSend}
			status={isSubmitting ? "submitted" : "ready"}
		/>
	);
};
