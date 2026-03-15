import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@tendril/backend/convex/_generated/api";
import { useMutation } from "convex/react";
import { nanoid } from "nanoid";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { AgentView, type ChatSendMessage } from "@/components/chat/agent-view";
import { ProjectSelectorEmptyState } from "@/components/project-selector-empty-state";
import { SpaceListSidebar } from "@/components/space-list-sidebar";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { useProjects } from "@/hooks/use-projects";
import { usePendingMessageStore } from "@/stores/pending-message-store";

export const Route = createFileRoute("/_authenticated/")({
	component: AuthenticatedIndex,
});

function AuthenticatedIndex() {
	const navigate = useNavigate();
	const { selectedProjectId } = useProjects();
	const createSpace = useMutation(api.spaces.create);
	const setMessage = usePendingMessageStore((s) => s.setMessage);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSend: ChatSendMessage = useCallback(
		async (input) => {
			const text = input.message.trim();
			if (!(text && selectedProjectId) || isSubmitting) {
				return;
			}

			setIsSubmitting(true);
			try {
				const spaceSlug = nanoid();
				const sessionId = nanoid();

				await createSpace({
					slug: spaceSlug,
					projectId: selectedProjectId,
					backing: input.backing,
				});

				setMessage({
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
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to create space"
				);
			} finally {
				setIsSubmitting(false);
			}
		},
		[createSpace, isSubmitting, navigate, selectedProjectId, setMessage]
	);

	return (
		<div className="flex h-full w-full overflow-hidden">
			<SpaceListSidebar />
			<SidebarInset className="min-h-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
				</header>

				<AgentView
					emptyState={<ProjectSelectorEmptyState />}
					messages={[]}
					sendMessage={handleSend}
					status={isSubmitting ? "submitted" : "ready"}
				/>
			</SidebarInset>
		</div>
	);
}
