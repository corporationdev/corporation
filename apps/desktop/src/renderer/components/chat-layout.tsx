import { Thread } from "@/components/assistant-ui/thread";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";

export function ChatLayout() {
	return (
		<div className="flex h-full w-full overflow-hidden">
			<ThreadListSidebar />
			<SidebarInset className="overflow-hidden!">
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger />
				</header>
				<Thread />
			</SidebarInset>
		</div>
	);
}
