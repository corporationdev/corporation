import { api } from "@corporation/backend/convex/_generated/api";
import type { SpaceTab } from "@corporation/server/space";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { PlusIcon, XIcon } from "lucide-react";
import type { FC } from "react";
import { SpaceListSidebar } from "@/components/assistant-ui/space-list-sidebar";
import { SandboxPausedPanel } from "@/components/sandbox-paused-panel";
import { SpaceNotFoundPanel } from "@/components/space-not-found-panel";
import { SpaceSidebar } from "@/components/space-sidebar";
import { SpaceSidebarToggle } from "@/components/space-sidebar-toggle";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { useSpaceTabs } from "@/hooks/use-space-tabs";
import { type SpaceActor, useActor } from "@/lib/rivetkit";
import { type TabParam, tabRegistry } from "@/lib/tab-registry";
import { parseTab, serializeTab } from "@/lib/tab-routing";
import { cn } from "@/lib/utils";

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
	const isSpaceLoading = space === undefined;
	const isSpaceMissing = !!spaceSlug && space === null;

	const sandboxReady = !!space?.sandboxId && !!space?.sandboxUrl;

	const actor = useActor({
		name: "space",
		key: spaceSlug ? [spaceSlug] : [],
		createWithInput: sandboxReady
			? {
					sandboxId: space.sandboxId,
					sandboxUrl: space.sandboxUrl,
				}
			: undefined,
		enabled: !!spaceSlug && sandboxReady,
	});

	const tabs = useSpaceTabs(actor);

	const activeTabType = tab?.type ?? "session";
	const activeTabConfig = tabRegistry[activeTabType];

	const shouldWaitForSandboxStatus =
		activeTabConfig.requiresSandbox && isSpaceLoading;
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
					<SpaceTabBar
						activeTab={tab}
						actor={actor}
						spaceSlug={spaceSlug}
						tabs={tabs}
					/>
				)}
				{isSpaceMissing ? (
					<SpaceNotFoundPanel />
				) : shouldWaitForSandboxStatus ? (
					<div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
						Loading sandbox status...
					</div>
				) : shouldShowSandboxPaused ? (
					<SandboxPausedPanel slug={space.slug} status={space.status} />
				) : (
					activeTabConfig.render({
						actor,
						tabId: tab?.id,
						spaceSlug,
						tabs,
					})
				)}
			</SidebarInset>
			<SpaceSidebar actor={actor} space={space} />
		</div>
	);
}

const SpaceTabBar: FC<{
	spaceSlug: string;
	activeTab: TabParam | undefined;
	actor: SpaceActor;
	tabs: SpaceTab[];
}> = ({ spaceSlug, activeTab, actor, tabs }) => {
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
				const tabIndex = tabs.findIndex((candidate) => candidate.id === tab.id);

				return (
					<div
						className={cn(
							"group/tab flex h-7 shrink-0 items-center rounded-md pr-1 transition-colors hover:bg-muted",
							isActive ? "bg-muted font-medium" : "text-muted-foreground"
						)}
						key={tab.id}
					>
						<button
							className="flex h-full min-w-0 items-center rounded-md px-3 text-sm"
							onClick={() =>
								navigate({
									to: "/space/$spaceSlug",
									params: { spaceSlug },
									search: { tab: serializeTab(tabParam) },
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

									await actor.connection.closeTab(tab.id);

									if (!isActive) {
										return;
									}

									const remainingTabs = tabs.filter(
										(candidate) => candidate.id !== tab.id
									);
									const nextTab =
										remainingTabs[tabIndex] ?? remainingTabs[tabIndex - 1];
									if (!nextTab) {
										navigate({
											to: "/space/$spaceSlug",
											params: { spaceSlug },
											search: {},
										});
										return;
									}

									const nextTabConfig = tabRegistry[nextTab.type];
									const nextTabParam =
										nextTabConfig.tabParamFromSpaceTab(nextTab);
									if (!nextTabParam) {
										navigate({
											to: "/space/$spaceSlug",
											params: { spaceSlug },
											search: {},
										});
										return;
									}

									navigate({
										to: "/space/$spaceSlug",
										params: { spaceSlug },
										search: { tab: serializeTab(nextTabParam) },
									});
								};

								close().catch((error: unknown) => {
									console.error("Failed to close tab", error);
								});
							}}
							type="button"
						>
							<XIcon className="size-3.5" />
							<span className="sr-only">Close tab</span>
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
