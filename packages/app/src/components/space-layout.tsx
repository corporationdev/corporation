import { api } from "@corporation/backend/convex/_generated/api";
import type { SpaceTab } from "@corporation/server/space";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import { type FC, useEffect } from "react";
import { SpaceListSidebar } from "@/components/assistant-ui/space-list-sidebar";
import { SandboxPausedPanel } from "@/components/sandbox-paused-panel";
import { SpaceSidebar } from "@/components/space-sidebar";
import { SpaceSidebarToggle } from "@/components/space-sidebar-toggle";
import { Button } from "@/components/ui/button";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { useSpaceTabs } from "@/hooks/use-space-tabs";
import { useActor } from "@/lib/rivetkit";
import { tabRegistry } from "@/lib/tab-registry";
import { parseTab, serializeTab, type TabParam } from "@/lib/tab-routing";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout-store";

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

	const tabs = useSpaceTabs(actor);

	const isOpen = useLayoutStore((s) => s.rightSidebarOpen);
	const setIsOpen = useLayoutStore((s) => s.setRightSidebarOpen);

	const activeTabType = tab?.type ?? "session";
	const activeTabConfig = tabRegistry[activeTabType];
	const shouldWaitForSandboxStatus = activeTabConfig.requiresSandbox && !space;
	const shouldShowSandboxPaused =
		activeTabConfig.requiresSandbox && !!space && space.status !== "started";

	return (
		<div className="flex h-full w-full overflow-hidden">
			<SpaceListSidebar />
			<SidebarInset className="overflow-hidden!">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					<div className="flex items-center gap-1">
						<SpaceSidebarToggle />
					</div>
				</header>
				{spaceSlug && (
					<SpaceTabBar activeTab={tab} spaceSlug={spaceSlug} tabs={tabs} />
				)}
				{shouldWaitForSandboxStatus ? (
					<div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
						Loading sandbox status...
					</div>
				) : shouldShowSandboxPaused && space ? (
					<SandboxPausedPanel slug={space.slug} status={space.status} />
				) : (
					activeTabConfig.render({
						actor,
						tabId: tab?.id,
						spaceSlug,
					})
				)}
			</SidebarInset>
			<SidebarProvider
				className="w-auto overflow-hidden"
				onOpenChange={setIsOpen}
				open={isOpen}
			>
				<SpaceSidebar actor={actor} space={space} />
			</SidebarProvider>
		</div>
	);
}

const SpaceTabBar: FC<{
	spaceSlug: string;
	activeTab: TabParam | undefined;
	tabs: SpaceTab[];
}> = ({ spaceSlug, activeTab, tabs }) => {
	const navigate = useNavigate();

	return (
		<div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2">
			{tabs.map((tab) => {
				const tabConfig = tabRegistry[tab.type];
				const tabParam = tabConfig.tabParamFromSpaceTab(tab);
				if (!tabParam) {
					return null;
				}

				const isActive =
					activeTab?.type === tabParam.type && activeTab.id === tabParam.id;
				const title = tab.title || tabConfig.defaultTitle;

				return (
					<button
						className={cn(
							"flex h-7 shrink-0 items-center rounded-md px-3 text-sm transition-colors hover:bg-muted",
							isActive ? "bg-muted font-medium" : "text-muted-foreground"
						)}
						key={tab.id}
						onClick={() =>
							navigate({
								to: "/space/$spaceSlug",
								params: { spaceSlug },
								search: { tab: serializeTab(tabParam) },
							})
						}
						type="button"
					>
						{title}
					</button>
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
