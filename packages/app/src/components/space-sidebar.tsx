import { useNavigate } from "@tanstack/react-router";
import { TerminalIcon } from "lucide-react";
import { nanoid } from "nanoid";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import type { SpaceActor } from "@/lib/rivetkit";
import { serializeTab } from "@/lib/tab-routing";
import { cn } from "@/lib/utils";

type SpaceSidebarProps = {
	spaceSlug: string;
	status: string;
	actor: SpaceActor;
};

const statusConfig: Record<string, { label: string; className: string }> = {
	creating: { label: "Creating", className: "bg-yellow-500" },
	starting: { label: "Starting", className: "bg-yellow-500" },
	started: { label: "Running", className: "bg-green-500" },
	stopped: { label: "Stopped", className: "bg-muted-foreground" },
	error: { label: "Error", className: "bg-destructive" },
};

export const SpaceSidebar: FC<SpaceSidebarProps> = ({
	spaceSlug,
	status,
	actor,
}) => {
	const navigate = useNavigate();
	const config = statusConfig[status] ?? {
		label: status,
		className: "bg-muted-foreground",
	};

	const handleNewTerminal = async () => {
		if (!actor.connection) {
			return;
		}

		const terminalId = nanoid();
		await actor.connection.ensureTerminal(terminalId);
		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: { tab: serializeTab({ type: "terminal", id: terminalId }) },
		});
	};

	return (
		<Sidebar collapsible="offcanvas" side="right">
			<SidebarContent className="p-4">
				<div className="flex flex-col gap-4">
					<div className="flex items-center gap-2">
						<div className={cn("size-2 rounded-full", config.className)} />
						<span className="text-muted-foreground text-sm">
							Sandbox: {config.label}
						</span>
					</div>
					<Button
						className="w-full justify-start gap-2"
						disabled={actor.connStatus !== "connected" || status !== "started"}
						onClick={() => {
							handleNewTerminal().catch((error: unknown) => {
								console.error("Failed to create terminal", error);
							});
						}}
						size="sm"
						variant="outline"
					>
						<TerminalIcon className="size-4" />
						New Terminal
					</Button>
				</div>
			</SidebarContent>
		</Sidebar>
	);
};
