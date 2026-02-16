import { api } from "@corporation/backend/convex/_generated/api";
import { useMatch } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { CopyInspectorUrl } from "@/components/copy-inspector-url";
import { SpaceSelector } from "@/components/space-selector";
import { ResizeHandle } from "@/components/terminal/resize-handle";
import { TerminalPanel } from "@/components/terminal/terminal-panel";
import { TerminalToggleButton } from "@/components/terminal/terminal-toggle-button";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
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
	const panelHeight = useTerminalStore((s) => s.panelHeight);

	const showTerminal = isOpen && sandboxId && sandboxUrl;

	return (
		<div className="flex h-full w-full overflow-hidden">
			<ThreadListSidebar />
			<SidebarInset className="overflow-hidden!">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					<div className="flex items-center gap-1">
						{match && <TerminalToggleButton slug={slug} />}
						{match && <CopyInspectorUrl slug={slug} />}
					</div>
					{isNewChat && <SpaceSelector />}
				</header>
				{showTerminal ? (
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="min-h-0 flex-1 overflow-hidden">
							<Thread />
						</div>
						<ResizeHandle />
						<div
							className="shrink-0 overflow-hidden"
							style={{ height: panelHeight }}
						>
							<TerminalPanel
								key={sandboxId}
								sandboxId={sandboxId}
								sandboxUrl={sandboxUrl}
							/>
						</div>
					</div>
				) : (
					<Thread />
				)}
			</SidebarInset>
		</div>
	);
}
