import { useMatch, useNavigate } from "@tanstack/react-router";
import { api } from "@tendril/backend/convex/_generated/api";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useQuery } from "convex/react";
import { HistoryIcon, PanelRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { ConnectedSessionView } from "@/components/connected-session-view";
import { NewSessionView } from "@/components/new-session-view";
import { SpaceListSidebar } from "@/components/space-list-sidebar";
import { SpaceNotFoundPanel } from "@/components/space-not-found-panel";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { WorkspacePanel } from "@/components/workspace-panel/workspace-panel";
import { useSpaceSessions } from "@/hooks/use-space-sessions";
import { cn } from "@/lib/utils";

const WORKSPACE_PANEL_OPEN_KEY = "tendril:workspace-panel-open";

export function SpaceLayout() {
	const match = useMatch({ from: "/_authenticated/space_/$spaceSlug" });
	const navigate = useNavigate();
	const { spaceSlug } = match.params;
	const activeSessionId: string | undefined = match.search.session;

	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });
	const { sessions, isLoading: isSessionsLoading } =
		useSpaceSessions(spaceSlug);
	const [workspacePanelOpen, setWorkspacePanelOpen] = useLocalStorage(
		WORKSPACE_PANEL_OPEN_KEY,
		true
	);
	const sessionStorageKey = `space-session:${spaceSlug}`;
	const [savedSessionId, setSavedSessionId] = useLocalStorage<string | null>(
		sessionStorageKey,
		null
	);
	const hasInitializedSession = useRef(false);
	const prevSpaceSlug = useRef(spaceSlug);

	useEffect(() => {
		if (activeSessionId) {
			setSavedSessionId(activeSessionId);
		}
	}, [activeSessionId, setSavedSessionId]);

	useEffect(() => {
		if (prevSpaceSlug.current !== spaceSlug) {
			prevSpaceSlug.current = spaceSlug;
			hasInitializedSession.current = false;
		}
		if (hasInitializedSession.current || isSessionsLoading) {
			return;
		}
		hasInitializedSession.current = true;
		if (activeSessionId || sessions.length === 0) {
			return;
		}

		const targetSessionId =
			savedSessionId &&
			sessions.some((session) => session.id === savedSessionId)
				? savedSessionId
				: sessions[0].id;

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: { session: targetSessionId },
			replace: true,
		});
	}, [
		activeSessionId,
		isSessionsLoading,
		navigate,
		savedSessionId,
		sessions,
		spaceSlug,
	]);

	const mainPane = (
		<div className="flex h-full w-full overflow-hidden">
			<SpaceListSidebar />
			<SidebarInset className="min-h-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					<div className="flex items-center gap-1">
						<Button
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
						<SessionHistoryPopover
							activeSessionId={activeSessionId}
							sessions={sessions}
							spaceSlug={spaceSlug}
						/>
						{workspacePanelOpen ? null : (
							<Button
								onClick={() => setWorkspacePanelOpen(true)}
								size="icon"
								variant="ghost"
							>
								<PanelRightIcon className="size-4" />
								<span className="sr-only">Open workspace panel</span>
							</Button>
						)}
					</div>
				</header>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					{activeSessionId ? (
						<ConnectedSessionView
							key={activeSessionId}
							sessionId={activeSessionId}
							spaceSlug={spaceSlug}
						/>
					) : space === null ? (
						<SpaceNotFoundPanel />
					) : (
						<NewSessionView key={spaceSlug} spaceSlug={spaceSlug} />
					)}
				</div>
			</SidebarInset>
		</div>
	);

	if (!workspacePanelOpen || space === null) {
		return mainPane;
	}

	return (
		<ResizablePanelGroup orientation="horizontal">
			<ResizablePanel>{mainPane}</ResizablePanel>
			<ResizableHandle />
			<ResizablePanel>
				<WorkspacePanel onClose={() => setWorkspacePanelOpen(false)} />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}

function SessionHistoryPopover({
	spaceSlug,
	activeSessionId,
	sessions,
}: {
	spaceSlug: string;
	activeSessionId: string | undefined;
	sessions: Array<{ id: string; title: string }>;
}) {
	const navigate = useNavigate();

	return (
		<Popover>
			<PopoverTrigger render={<Button size="icon" variant="ghost" />}>
				<HistoryIcon className="size-4" />
				<span className="sr-only">Session history</span>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64 p-1">
				{sessions.length === 0 ? (
					<p className="px-2 py-3 text-center text-muted-foreground text-xs">
						No sessions yet
					</p>
				) : (
					<div className="flex max-h-72 flex-col overflow-y-auto">
						{sessions.map((session) => {
							const isActive = activeSessionId === session.id;
							return (
								<button
									className={cn(
										"flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
										isActive && "bg-accent font-medium"
									)}
									key={session.id}
									onClick={() =>
										navigate({
											to: "/space/$spaceSlug",
											params: { spaceSlug },
											search: { session: session.id },
										})
									}
									type="button"
								>
									<span className="truncate">
										{session.title || "New Chat"}
									</span>
								</button>
							);
						})}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
