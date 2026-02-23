import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import type { FC } from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { CopyInspectorUrl } from "@/components/copy-inspector-url";
import { TerminalSidebar } from "@/components/terminal/terminal-sidebar";
import { TerminalToggleButton } from "@/components/terminal/terminal-toggle-button";
import { Button } from "@/components/ui/button";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/stores/terminal-store";

export function ChatLayout() {
	const match = useMatch({
		from: "/_authenticated/space/$spaceSlug",
		shouldThrow: false,
	});
	const spaceSlug = match?.params.spaceSlug;
	const sessionSlug = (match?.search as { session?: string })?.session;

	const space = useQuery(
		api.spaces.getBySlug,
		spaceSlug ? { slug: spaceSlug } : "skip"
	);

	const session = useQuery(
		api.agentSessions.getBySlug,
		sessionSlug ? { slug: sessionSlug } : "skip"
	);

	const sandboxId = session?.space.sandboxId ?? space?.sandboxId ?? null;
	const sandboxUrl = session?.space.sandboxUrl ?? space?.sandboxUrl ?? null;

	const isOpen = useTerminalStore((s) => s.isOpen);
	const setIsOpen = useTerminalStore((s) => s.setIsOpen);

	return (
		<div className="flex h-full w-full overflow-hidden">
			<ThreadListSidebar />
			<SidebarInset className="overflow-hidden!">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					<div className="flex items-center gap-1">
						{sandboxUrl && <CopyInspectorUrl sandboxUrl={sandboxUrl} />}
						{sandboxId && <TerminalToggleButton />}
					</div>
				</header>
				{spaceSlug && space && (
					<SessionTabBar
						activeSlug={sessionSlug}
						spaceId={space._id}
						spaceSlug={spaceSlug}
					/>
				)}
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

const SessionTabBar: FC<{
	spaceId: Id<"spaces">;
	spaceSlug: string;
	activeSlug: string | undefined;
}> = ({ spaceId, spaceSlug, activeSlug }) => {
	const navigate = useNavigate();
	const sessions = useQuery(api.agentSessions.listBySpace, { spaceId });

	const activeSessions = sessions?.filter((s) => s.archivedAt === null);

	return (
		<div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2">
			{activeSessions?.map((session) => (
				<button
					className={cn(
						"flex h-7 shrink-0 items-center rounded-md px-3 text-sm transition-colors hover:bg-muted",
						activeSlug === session.slug
							? "bg-muted font-medium"
							: "text-muted-foreground"
					)}
					key={session._id}
					onClick={() =>
						navigate({
							to: "/space/$spaceSlug",
							params: { spaceSlug },
							search: { session: session.slug },
						})
					}
					type="button"
				>
					{session.title || "New Chat"}
				</button>
			))}
			<Button
				className="size-7 shrink-0"
				onClick={() =>
					navigate({
						to: "/space/$spaceSlug",
						params: { spaceSlug },
						search: {},
					})
				}
				size="icon"
				variant="ghost"
			>
				<PlusIcon className="size-4" />
				<span className="sr-only">New session</span>
			</Button>
		</div>
	);
};
