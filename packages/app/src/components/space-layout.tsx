import { api } from "@corporation/backend/convex/_generated/api";
import type { SessionRow } from "@corporation/server/space";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { PlusIcon, XIcon } from "lucide-react";
import { type FC, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SessionView } from "@/components/session-view";
import { SpaceListSidebar } from "@/components/space-list-sidebar";
import { SpaceNotFoundPanel } from "@/components/space-not-found-panel";
import { SpaceSidebar } from "@/components/space-sidebar";
import { SpaceSidebarToggle } from "@/components/space-sidebar-toggle";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { useSpaceSessions } from "@/hooks/use-space-sessions";
import { addActorConnectionSoftResetListener } from "@/lib/actor-errors";
import { type SpaceActor, useActor } from "@/lib/rivetkit";
import { cn } from "@/lib/utils";
import { usePendingMessageStore } from "@/stores/pending-message-store";

export function SpaceLayout() {
	const match = useMatch({ from: "/_authenticated/space_/$spaceSlug" });
	const { spaceSlug } = match.params;
	const activeSessionId: string | undefined = match.search.session;

	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });
	const isSpaceMissing = space === null;
	const [connectionResetNonce, setConnectionResetNonce] = useState(0);
	const lastResetAtRef = useRef(0);
	const [spaceCreating, setSpaceCreating] = useState(false);

	const ensureSpace = useMutation(api.spaces.ensure);
	const consumeSpace = usePendingMessageStore((s) => s.consumeSpace);

	useEffect(() => {
		const pending = consumeSpace();
		if (!pending) {
			return;
		}
		setSpaceCreating(true);
		ensureSpace({ slug: pending.slug, repositoryId: pending.repositoryId })
			.catch((error: unknown) => {
				console.error("Failed to create space", error);
				toast.error("Failed to create space");
			})
			.finally(() => {
				setSpaceCreating(false);
			});
	}, [consumeSpace, ensureSpace]);

	const sandboxReady = !!space?.sandboxId && !!space?.agentUrl;

	useEffect(() => {
		return addActorConnectionSoftResetListener(
			({ reason, spaceSlug: target }) => {
				if (target && target !== spaceSlug) {
					return;
				}

				const now = Date.now();
				if (now - lastResetAtRef.current < 1000) {
					return;
				}
				lastResetAtRef.current = now;

				setConnectionResetNonce((value) => {
					const next = value + 1;
					console.warn("space.actor.soft-reset", { spaceSlug, reason, next });
					return next;
				});
			}
		);
	}, [spaceSlug]);

	const actor = useActor({
		name: "space",
		key: [spaceSlug],
		params: { reconnectNonce: String(connectionResetNonce) },
		createWithInput: sandboxReady
			? {
					sandboxId: space.sandboxId,
					agentUrl: space.agentUrl,
					workdir: space.workdir,
				}
			: undefined,
		enabled: sandboxReady,
	});

	const navigate = useNavigate();
	const { sessions, isLoading: isSessionsLoading } = useSpaceSessions(actor);

	// Persist the active session so we can restore it when returning to this space
	useEffect(() => {
		if (activeSessionId) {
			localStorage.setItem(`space-session:${spaceSlug}`, activeSessionId);
		}
	}, [activeSessionId, spaceSlug]);

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
		const saved = localStorage.getItem(`space-session:${spaceSlug}`);
		const targetSessionId =
			saved && sessions.some((s) => s.id === saved) ? saved : sessions[0].id;

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: { session: targetSessionId },
			replace: true,
		});
	}, [activeSessionId, sessions, isSessionsLoading, spaceSlug, navigate]);

	return (
		<div className="flex h-full w-full overflow-hidden">
			<SpaceListSidebar />
			<SidebarInset className="min-h-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					<div className="flex items-center gap-1">
						<SpaceSidebarToggle />
					</div>
				</header>
				<SessionTabBar
					activeSessionId={activeSessionId}
					actor={actor}
					sessions={sessions}
					spaceSlug={spaceSlug}
				/>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					{isSpaceMissing && !spaceCreating ? (
						<SpaceNotFoundPanel />
					) : (
						<SessionView
							actor={actor}
							key={activeSessionId ?? spaceSlug}
							sessionId={activeSessionId}
							spaceSlug={spaceSlug}
						/>
					)}
				</div>
			</SidebarInset>
			<SpaceSidebar actor={actor} space={space} />
		</div>
	);
}

const SessionTabBar: FC<{
	spaceSlug: string;
	activeSessionId: string | undefined;
	actor: SpaceActor;
	sessions: SessionRow[];
}> = ({ spaceSlug, activeSessionId, actor, sessions }) => {
	const navigate = useNavigate();

	return (
		<div className="sticky top-0 z-20 flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b bg-background px-2">
			{sessions.map((session) => {
				const isActive = activeSessionId === session.id;
				const title = session.title || "New Chat";
				const sessionIndex = sessions.findIndex((s) => s.id === session.id);

				return (
					<div
						className={cn(
							"group/tab flex h-7 shrink-0 items-center rounded-md pr-1 transition-colors hover:bg-muted",
							isActive ? "bg-muted font-medium" : "text-muted-foreground"
						)}
						key={session.id}
					>
						<button
							className="flex h-full min-w-0 items-center rounded-md px-3 text-sm"
							onClick={() =>
								navigate({
									to: "/space/$spaceSlug",
									params: { spaceSlug },
									search: { session: session.id },
								})
							}
							type="button"
						>
							<span className="truncate">{title}</span>
						</button>
						<button
							className="flex size-5 shrink-0 items-center justify-center rounded opacity-70 transition-opacity hover:bg-accent hover:opacity-100 group-hover/tab:opacity-100"
							disabled={actor.connStatus !== "connected" || !actor.connection}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();

								const close = async () => {
									if (!actor.connection) {
										return;
									}

									await actor.connection.closeSession(session.id);

									if (!isActive) {
										return;
									}

									const remaining = sessions.filter((s) => s.id !== session.id);
									const next =
										remaining[sessionIndex] ?? remaining[sessionIndex - 1];
									navigate({
										to: "/space/$spaceSlug",
										params: { spaceSlug },
										search: next ? { session: next.id } : {},
									});
								};

								close().catch((error: unknown) => {
									console.error("Failed to close session", error);
								});
							}}
							type="button"
						>
							<XIcon className="size-3.5" />
							<span className="sr-only">Close session</span>
						</button>
					</div>
				);
			})}
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
