import { api } from "@corporation/backend/convex/_generated/api";
import { useMatch } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { CopyInspectorUrl } from "@/components/copy-inspector-url";
import { SpaceSelector } from "@/components/space-selector";
import { TerminalSidebar } from "@/components/terminal/terminal-sidebar";
import { TerminalToggleButton } from "@/components/terminal/terminal-toggle-button";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { useTerminalStore } from "@/stores/terminal-store";

export function ChatLayout() {
	const match = useMatch({
		from: "/_authenticated/chat/$slug",
		shouldThrow: false,
	});
	const isNewChat = !match;
	const slug = match?.params.slug;

	const session = useQuery(
		api.agentSessions.getBySlug,
		slug ? { slug } : "skip"
	);
	const sandboxId = session?.space.sandboxId ?? null;
	const sandboxUrl = session?.space.sandboxUrl ?? null;
	const isOpen = useTerminalStore((s) => s.isOpen);
	const setIsOpen = useTerminalStore((s) => s.setIsOpen);

	return (
		<div className="flex h-full w-full overflow-hidden">
			<ThreadListSidebar />
			<SidebarInset className="overflow-hidden!">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					<div className="flex items-center gap-1">
						{isNewChat && <SpaceSelector />}
						{sandboxUrl && <CopyInspectorUrl sandboxUrl={sandboxUrl} />}
						{sandboxId && <TerminalToggleButton />}
					</div>
				</header>
				<Thread />
			</SidebarInset>
			{sandboxId && (
				<SidebarProvider
					className="w-auto overflow-hidden"
					onOpenChange={setIsOpen}
					open={isOpen}
				>
					<TerminalSidebar sandboxId={sandboxId} />
				</SidebarProvider>
			)}
		</div>
	);
}
