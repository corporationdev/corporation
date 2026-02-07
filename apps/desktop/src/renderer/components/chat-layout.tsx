import type { ReactNode } from "react";

import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";

type ChatLayoutProps = {
	children: ReactNode;
};

export function ChatLayout({ children }: ChatLayoutProps) {
	return (
		<div className="flex h-full w-full overflow-hidden">
			<ThreadListSidebar />
			<SidebarInset className="!overflow-hidden">
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger />
				</header>
				<div className="min-h-0 flex-1">{children}</div>
			</SidebarInset>
		</div>
	);
}
