import { GitBranchIcon, MonitorIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import type { SpaceActor } from "@/lib/rivetkit";
import { cn } from "@/lib/utils";
import { TerminalTab } from "./terminal-tab";

const tabs = [
	{ id: "git", label: "Git", icon: GitBranchIcon },
	{ id: "desktop", label: "Desktop", icon: MonitorIcon },
	{ id: "terminal", label: "Terminal", icon: TerminalIcon },
] as const;

type TabId = (typeof tabs)[number]["id"];

type WorkspacePanelProps = {
	actor: SpaceActor;
	spaceSlug: string;
};

export function WorkspacePanel({ actor, spaceSlug }: WorkspacePanelProps) {
	const [activeTab, setActiveTab] = useState<TabId>("terminal");

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
				{activeTab === "git" && (
					<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
						Git panel coming soon
					</div>
				)}
				{activeTab === "desktop" && (
					<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
						Desktop panel coming soon
					</div>
				)}
			</div>
		</div>
	);
}
