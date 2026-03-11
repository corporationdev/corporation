import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useNavigate } from "@tanstack/react-router";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useMutation } from "convex/react";
import { HistoryIcon, PanelRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SessionView } from "@/components/session-view";
import { SpaceListSidebar } from "@/components/space-list-sidebar";
import { SpaceNotFoundPanel } from "@/components/space-not-found-panel";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { useSpaceSessions } from "@/hooks/use-space-sessions";
import type { SpaceActor } from "@/lib/space-client";
import { cn } from "@/lib/utils";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import type { SessionRow } from "../../../../apps/server/src/space-do/object";

type AgentPanelProps = {
	actor: SpaceActor;
	isBindingSynced: boolean;
	spaceSlug: string;
	activeSessionId: string | undefined;
	workspacePanelOpen: boolean;
	onToggleWorkspacePanel: () => void;
	space:
		| {
				_id: Id<"spaces">;
				status: string;
				error?: string;
				sandboxId?: string;
		  }
		| null
		| undefined;
};

export function AgentPanel({
	actor,
	isBindingSynced,
	spaceSlug,
	activeSessionId,
	space,
	workspacePanelOpen,
	onToggleWorkspacePanel,
}: AgentPanelProps) {
	const isSpaceMissing = space === null;
	const [spaceCreating, setSpaceCreating] = useState(false);

	const ensureSpace = useMutation(api.spaces.ensure);
	const consumeSpace = usePendingMessageStore((s) => s.consumeSpace);
	const pendingMessage = usePendingMessageStore((s) => s.message);

	useEffect(() => {
		const pending = consumeSpace();
		if (!pending) {
			return;
		}
		setSpaceCreating(true);
		ensureSpace({
			slug: pending.slug,
			projectId: pending.projectId,
			snapshotId: pending.snapshotId,
			firstMessage: pendingMessage?.text,
		})
			.catch((error: unknown) => {
				console.error("Failed to create space", error);
				toast.error("Failed to create space");
			})
			.finally(() => {
				setSpaceCreating(false);
			});
	}, [consumeSpace, pendingMessage, ensureSpace]);

	const navigate = useNavigate();
	const { sessions, isLoading: isSessionsLoading } = useSpaceSessions(actor);
	const sessionStorageKey = `space-session:${spaceSlug}`;
	const [savedSessionId, setSavedSessionId] = useLocalStorage<string | null>(
		sessionStorageKey,
		null
	);

	// Persist the active session so we can restore it when returning to this space
	useEffect(() => {
		if (activeSessionId) {
			setSavedSessionId(activeSessionId);
		}
	}, [activeSessionId, setSavedSessionId]);

	// Restore the last active session on initial navigation (not when pressing "+")
	const hasInitializedSession = useRef(false);
	const prevSpaceSlug = useRef(spaceSlug);
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

		// Try to restore the last active session, fall back to the first session
		const targetSessionId =
			savedSessionId && sessions.some((s) => s.id === savedSessionId)
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
		savedSessionId,
		sessions,
		isSessionsLoading,
		spaceSlug,
		navigate,
	]);

	return (
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
						{!workspacePanelOpen && (
							<Button
								onClick={onToggleWorkspacePanel}
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
					{isSpaceMissing && !spaceCreating ? (
						<SpaceNotFoundPanel />
					) : (
						<SessionView
							actor={actor}
							isBindingSynced={isBindingSynced}
							key={activeSessionId ?? spaceSlug}
							sessionId={activeSessionId}
							spaceSlug={spaceSlug}
						/>
					)}
				</div>
			</SidebarInset>
		</div>
	);
}

function SessionHistoryPopover({
	spaceSlug,
	activeSessionId,
	sessions,
}: {
	spaceSlug: string;
	activeSessionId: string | undefined;
	sessions: SessionRow[];
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
