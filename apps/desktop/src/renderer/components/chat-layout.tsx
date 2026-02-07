import { ExternalLinkIcon } from "lucide-react";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSandboxStore } from "@/stores/sandbox-store";

export function ChatLayout() {
	const previewUrl = useSandboxStore((s) => s.previewUrl);
	const inspectorUrl = previewUrl ? `${previewUrl}/ui/` : null;

	return (
		<div className="flex h-full w-full overflow-hidden">
			<ThreadListSidebar />
			<SidebarInset className="overflow-hidden!">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					{inspectorUrl && (
						<Tooltip>
							<Button
								onClick={() => window.open(inspectorUrl, "_blank")}
								render={<TooltipTrigger />}
								size="icon-sm"
								variant="ghost"
							>
								<ExternalLinkIcon />
								<span className="sr-only">Open Inspector</span>
							</Button>
							<TooltipContent side="bottom">Open Inspector</TooltipContent>
						</Tooltip>
					)}
				</header>
				<Thread />
			</SidebarInset>
		</div>
	);
}
