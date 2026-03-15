import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { nanoid } from "nanoid";
import { useCallback } from "react";
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
	const setMessage = usePendingMessageStore((s) => s.setMessage);

	const handleSend: ChatSendMessage = useCallback(
		(input) => {
			const text = input.message.trim();
			if (!(text && selectedProjectId)) {
				return Promise.resolve();
			}

			const spaceSlug = nanoid();
			const sessionId = nanoid();

			setMessage({
				text,
				agent: input.agentId,
				modelId: input.modelId,
				modeId: input.modeId,
				reasoningEffort: input.reasoningEffort,
				spaceCreation: {
					projectId: selectedProjectId,
					backing: input.backing,
				},
			});

			navigate({
				to: "/space/$spaceSlug",
				params: { spaceSlug },
				search: { session: sessionId },
			});

			return Promise.resolve();
		},
		[navigate, selectedProjectId, setMessage]
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
					status="ready"
				/>
			</SidebarInset>
		</div>
	);
}
