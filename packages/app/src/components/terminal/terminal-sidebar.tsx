import { TerminalPanel } from "@/components/terminal/terminal-panel";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";

type TerminalSidebarProps = {
	sandboxId: string;
};

export function TerminalSidebar({ sandboxId }: TerminalSidebarProps) {
	return (
		<Sidebar collapsible="offcanvas" side="right">
			<SidebarContent>
				<TerminalPanel key={sandboxId} sandboxId={sandboxId} />
			</SidebarContent>
		</Sidebar>
	);
}
