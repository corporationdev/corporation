import { CheckIcon, ClipboardIcon } from "lucide-react";
import { useCallback, useState } from "react";
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
	const [copied, setCopied] = useState(false);

	const copyInspectorUrl = useCallback(() => {
		if (!inspectorUrl) {
			return;
		}
		navigator.clipboard.writeText(inspectorUrl);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}, [inspectorUrl]);

	return (
		<div className="flex h-full w-full overflow-hidden">
			<ThreadListSidebar />
			<SidebarInset className="overflow-hidden!">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
					{inspectorUrl && (
						<Tooltip>
							<Button
								onClick={copyInspectorUrl}
								render={<TooltipTrigger />}
								size="icon-sm"
								variant="ghost"
							>
								{copied ? <CheckIcon /> : <ClipboardIcon />}
								<span className="sr-only">Copy Inspector URL</span>
							</Button>
							<TooltipContent side="bottom">
								{copied ? "Copied!" : "Copy Inspector URL"}
							</TooltipContent>
						</Tooltip>
					)}
				</header>
				<Thread />
			</SidebarInset>
		</div>
	);
}
