import { useMatch } from "@tanstack/react-router";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { SpaceSelector } from "@/components/space-selector";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";

export function ChatLayout() {
	const match = useMatch({
		from: "/_authenticated/chat/$slug",
		shouldThrow: false,
	});
	const isNewChat = !match;

	return (
		<div className="flex h-full w-full overflow-hidden">
			<ThreadListSidebar />
			<SidebarInset className="overflow-hidden!">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					{isNewChat && <SpaceSelector />}
				</header>
				<Thread />
			</SidebarInset>
		</div>
	);
}
