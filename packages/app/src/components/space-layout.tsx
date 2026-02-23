import { api } from "@corporation/backend/convex/_generated/api";
import type {
	SessionTab,
	SpaceTab,
	TerminalTab,
} from "@corporation/server/space";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import { type FC, useEffect, useState } from "react";
import { SpaceListSidebar } from "@/components/assistant-ui/space-list-sidebar";
import { CopyInspectorUrl } from "@/components/copy-inspector-url";
import { SessionView } from "@/components/session-view";
import { SpaceSidebar } from "@/components/space-sidebar";
import { SpaceSidebarToggle } from "@/components/space-sidebar-toggle";
import { TerminalView } from "@/components/terminal-view";
import { Button } from "@/components/ui/button";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { useActor } from "@/lib/rivetkit";
import { parseTab, serializeTab, type TabParam } from "@/lib/tab-routing";
import { cn } from "@/lib/utils";
import { useSpaceSidebarStore } from "@/stores/space-sidebar-store";

export function SpaceLayout() {
	const match = useMatch({
		from: "/_authenticated/space/$spaceSlug",
		shouldThrow: false,
	});
	const spaceSlug = match?.params.spaceSlug;
	const tab = parseTab(match?.search.tab);

	const space = useQuery(
		api.spaces.getBySlug,
		spaceSlug ? { slug: spaceSlug } : "skip"
	);

	const actor = useActor({
		name: "space",
		key: spaceSlug ? [spaceSlug] : [],
		createWithInput: space
			? {
					sandboxId: space.sandboxId,
					sandboxUrl: space.sandboxUrl,
				}
			: undefined,
		enabled: !!spaceSlug,
	});

	// sync do with convex
	useEffect(() => {
		if (
			!spaceSlug ||
			actor.connStatus !== "connected" ||
			!actor.connection ||
			!space
		) {
			return;
		}

		actor.connection
			.setSandboxContext(space.sandboxId ?? null, space.sandboxUrl ?? null)
			.catch((error: unknown) => {
				console.error("Failed to sync sandbox context", error);
			});
	}, [spaceSlug, actor.connStatus, actor.connection, space]);

	const [tabs, setTabs] = useState<SpaceTab[]>([]);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}
		actor.connection
			.listTabs()
			.then((nextTabs) => setTabs(nextTabs as unknown as SpaceTab[]))
			.catch((error: unknown) => {
				console.error("Failed to fetch tabs", error);
			});
	}, [actor.connStatus, actor.connection]);

	actor.useEvent("tabs.changed", () => {
		actor.connection
			?.listTabs()
			.then((nextTabs) => setTabs(nextTabs as unknown as SpaceTab[]))
			.catch((error: unknown) => {
				console.error("Failed to fetch tabs", error);
			});
	});

	const isOpen = useSpaceSidebarStore((s) => s.isOpen);
	const setIsOpen = useSpaceSidebarStore((s) => s.setIsOpen);

	const sessionId = tab?.type === "session" ? tab.id : undefined;

	return (
		<div className="flex h-full w-full overflow-hidden">
			<SpaceListSidebar />
			<SidebarInset className="overflow-hidden!">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					<div className="flex items-center gap-1">
						{space?.sandboxUrl && (
							<CopyInspectorUrl sandboxUrl={space.sandboxUrl} />
						)}
						{space?.sandboxId && <SpaceSidebarToggle />}
					</div>
				</header>
				{spaceSlug && (
					<SpaceTabBar activeTab={tab} spaceSlug={spaceSlug} tabs={tabs} />
				)}
				{(!tab || tab.type === "session") && (
					<SessionView
						actor={actor}
						sessionId={sessionId}
						spaceSlug={spaceSlug}
					/>
				)}
				{tab?.type === "terminal" && (
					<TerminalView actor={actor} key={tab.id} terminalId={tab.id} />
				)}
			</SidebarInset>
			{spaceSlug && space && (
				<SidebarProvider
					className="w-auto overflow-hidden"
					onOpenChange={setIsOpen}
					open={isOpen}
				>
					<SpaceSidebar
						actor={actor}
						spaceSlug={spaceSlug}
						status={space.status}
					/>
				</SidebarProvider>
			)}
		</div>
	);
}

const SpaceTabBar: FC<{
	spaceSlug: string;
	activeTab: TabParam | undefined;
	tabs: SpaceTab[];
}> = ({ spaceSlug, activeTab, tabs }) => {
	const navigate = useNavigate();

	const sessionTabs = tabs.filter((t): t is SessionTab => t.type === "session");
	const terminalTabs = tabs.filter(
		(t): t is TerminalTab => t.type === "terminal"
	);

	return (
		<div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2">
			{sessionTabs.map((sessionTab) => (
				<button
					className={cn(
						"flex h-7 shrink-0 items-center rounded-md px-3 text-sm transition-colors hover:bg-muted",
						activeTab?.type === "session" &&
							activeTab.id === sessionTab.sessionId
							? "bg-muted font-medium"
							: "text-muted-foreground"
					)}
					key={sessionTab.id}
					onClick={() =>
						navigate({
							to: "/space/$spaceSlug",
							params: { spaceSlug },
							search: {
								tab: serializeTab({
									type: "session",
									id: sessionTab.sessionId,
								}),
							},
						})
					}
					type="button"
				>
					{sessionTab.title || "New Chat"}
				</button>
			))}
			{terminalTabs.map((terminalTab) => (
				<button
					className={cn(
						"flex h-7 shrink-0 items-center rounded-md px-3 text-sm transition-colors hover:bg-muted",
						activeTab?.type === "terminal" &&
							activeTab.id === terminalTab.terminalId
							? "bg-muted font-medium"
							: "text-muted-foreground"
					)}
					key={terminalTab.id}
					onClick={() =>
						navigate({
							to: "/space/$spaceSlug",
							params: { spaceSlug },
							search: {
								tab: serializeTab({
									type: "terminal",
									id: terminalTab.terminalId,
								}),
							},
						})
					}
					type="button"
				>
					{terminalTab.title || "Terminal"}
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
