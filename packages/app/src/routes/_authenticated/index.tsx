import { createFileRoute } from "@tanstack/react-router";
import {
	AgentView,
	type ChatSendMessage,
	type ChatSendMessageInput,
} from "@/components/chat/agent-view";
import { ProjectSelectorEmptyState } from "@/components/project-selector-empty-state";
import { SpaceListSidebar } from "@/components/space-list-sidebar";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_authenticated/")({
	component: AuthenticatedIndex,
});

function AuthenticatedIndex() {
	const handleSend: ChatSendMessage = async (input: ChatSendMessageInput) => {
		console.log("send message", input);
		return await Promise.resolve();
	};
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
