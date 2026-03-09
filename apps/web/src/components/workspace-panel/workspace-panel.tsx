import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useLocalStorage } from "@uidotdev/usehooks";
import { MonitorIcon, PanelRightIcon, TerminalIcon } from "lucide-react";
import { CreateSnapshotPopover } from "@/components/create-snapshot-popover";
import { PtyTerminal } from "@/components/terminal/pty-terminal";
import { Button } from "@/components/ui/button";
import type { SpaceActor } from "@/lib/rivetkit";
import { cn } from "@/lib/utils";
import { DesktopTab } from "./desktop-tab";
import { SandboxPausedState } from "./sandbox-paused-state";

const tabs = [
	{ id: "terminal", label: "Terminal", icon: TerminalIcon },
	{ id: "desktop", label: "Desktop", icon: MonitorIcon },
] as const;

type TabId = (typeof tabs)[number]["id"];
const defaultTab: TabId = "terminal";
const WORKSPACE_TAB_STORAGE_KEY_PREFIX = "corporation:space-workspace-tab:";

function isTabId(value: string): value is TabId {
	return tabs.some((tab) => tab.id === value);
}

function getWorkspaceTabStorageKey(spaceSlug: string) {
	return `${WORKSPACE_TAB_STORAGE_KEY_PREFIX}${spaceSlug}`;
}

type WorkspacePanelProps = {
	actor: SpaceActor;
	onClose: () => void;
	space:
		| {
				_id: Id<"spaces">;
				status?: "creating" | "running" | "paused" | "killed" | "error";
				sandboxId?: string | null;
		  }
		| null
		| undefined;
	spaceSlug: string;
};

export function WorkspacePanel({
	actor,
	onClose,
	space,
	spaceSlug,
}: WorkspacePanelProps) {
	const storageKey = getWorkspaceTabStorageKey(spaceSlug);
	const [storedActiveTab, setActiveTab] = useLocalStorage<TabId>(
		storageKey,
		defaultTab
	);
	const activeTab = isTabId(storedActiveTab) ? storedActiveTab : defaultTab;
	const isWorkspaceAvailable =
		space?.status === "running" && !!space?.sandboxId;
	const workspaceFallbackStatus =
		space === undefined ? "loading" : (space?.status ?? "paused");
	const workspaceFallback = (
		<SandboxPausedState
			spaceSlug={spaceSlug}
			status={workspaceFallbackStatus}
		/>
	);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-1">
				<div className="flex items-center">
					{tabs.map((tab) => (
						<button
							className={cn(
								"inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
								activeTab === tab.id
									? "bg-accent font-medium text-foreground"
									: "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
							)}
							key={tab.id}
							onClick={() => setActiveTab(tab.id)}
							type="button"
						>
							<tab.icon className="size-3.5" />
							{tab.label}
						</button>
					))}
				</div>
				<div className="flex items-center gap-1 pr-1">
					<CreateSnapshotPopover
						sandboxId={space?.sandboxId ?? undefined}
						spaceId={space?._id}
						status={space?.status}
					/>
					<Button onClick={onClose} size="icon" variant="ghost">
						<PanelRightIcon className="size-4" />
						<span className="sr-only">Close workspace panel</span>
					</Button>
				</div>
			</div>
			<div className="min-h-0 flex-1">
				{activeTab === "terminal" &&
					(isWorkspaceAvailable ? (
						<PtyTerminal actor={actor} spaceSlug={spaceSlug} />
					) : (
						workspaceFallback
					))}
				{activeTab === "desktop" &&
					(isWorkspaceAvailable ? (
						<DesktopTab
							actor={actor}
							sandboxId={space?.sandboxId}
							spaceSlug={spaceSlug}
						/>
					) : (
						workspaceFallback
					))}
			</div>
		</div>
	);
}
