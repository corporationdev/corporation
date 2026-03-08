import { useLocalStorage } from "@uidotdev/usehooks";
import { MonitorIcon, TerminalIcon } from "lucide-react";
import type { SpaceActor } from "@/lib/rivetkit";
import { cn } from "@/lib/utils";
import { DesktopTab } from "./desktop-tab";
import { TerminalTab } from "./terminal-tab";

const tabs = [
	{ id: "desktop", label: "Desktop", icon: MonitorIcon },
	{ id: "terminal", label: "Terminal", icon: TerminalIcon },
] as const;

type TabId = (typeof tabs)[number]["id"];
const defaultTab: TabId = "terminal";

function isTabId(value: string): value is TabId {
	return tabs.some((tab) => tab.id === value);
}

type WorkspacePanelProps = {
	actor: SpaceActor;
	spaceSlug: string;
};

export function WorkspacePanel({ actor, spaceSlug }: WorkspacePanelProps) {
	const [storedActiveTab, setActiveTab] = useLocalStorage<string>(
		`space-workspace-tab:${spaceSlug}`,
		defaultTab
	);
	const activeTab = isTabId(storedActiveTab) ? storedActiveTab : defaultTab;

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex h-12 shrink-0 items-center border-b px-1">
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
			<div className="min-h-0 flex-1">
				{activeTab === "terminal" && (
					<TerminalTab actor={actor} spaceSlug={spaceSlug} />
				)}
				{activeTab === "desktop" && <DesktopTab actor={actor} />}
			</div>
		</div>
	);
}
