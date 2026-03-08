import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useLocalStorage } from "@uidotdev/usehooks";
import { MonitorIcon, TerminalIcon } from "lucide-react";
import { CreateSnapshotPopover } from "@/components/create-snapshot-popover";
import type { SpaceActor } from "@/lib/rivetkit";
import { cn } from "@/lib/utils";
import { DesktopTab } from "./desktop-tab";
import { TerminalTab } from "./terminal-tab";

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
	space:
		| {
				_id: Id<"spaces">;
				sandboxId?: string;
		  }
		| null
		| undefined;
	spaceSlug: string;
};

export function WorkspacePanel({
	actor,
	space,
	spaceSlug,
}: WorkspacePanelProps) {
	const storageKey = getWorkspaceTabStorageKey(spaceSlug);
	const [storedActiveTab, setActiveTab] = useLocalStorage<TabId>(
		storageKey,
		defaultTab
	);
	const activeTab = isTabId(storedActiveTab) ? storedActiveTab : defaultTab;

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
				<div className="pr-1">
					<CreateSnapshotPopover
						sandboxId={space?.sandboxId}
						spaceId={space?._id}
					/>
				</div>
			</div>
			<div className="min-h-0 flex-1">
				{activeTab === "terminal" && (
					<TerminalTab actor={actor} spaceSlug={spaceSlug} />
				)}
				{activeTab === "desktop" && <DesktopTab actor={actor} />}
			</div>
		</div>
	);
}
