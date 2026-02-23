import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { LoaderIcon, PlayIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { nanoid } from "nanoid";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import type { SpaceActor } from "@/lib/rivetkit";
import { serializeTab } from "@/lib/tab-routing";
import { cn } from "@/lib/utils";

type SpaceSidebarProps = {
	spaceId: Id<"spaces">;
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
	spaceId,
	spaceSlug,
	status,
	actor,
}) => {
	const navigate = useNavigate();
	const config = statusConfig[status] ?? {
		label: status,
		className: "bg-muted-foreground",
	};

	const ensureSpace = useMutation(api.spaces.ensure);
	const stopSpace = useMutation(api.spaces.stop);

	const startMutation = useTanstackMutation({
		mutationFn: () => ensureSpace({ spaceId }),
	});

	const stopMutation = useTanstackMutation({
		mutationFn: () => stopSpace({ id: spaceId }),
	});

	const isTransitioning = status === "creating" || status === "starting";
	const isStopped = status === "stopped" || status === "error";
	const isStarted = status === "started";

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
					{isStopped && (
						<Button
							className="w-full justify-start gap-2"
							disabled={startMutation.isPending}
							onClick={() => startMutation.mutate()}
							size="sm"
							variant="outline"
						>
							{startMutation.isPending ? (
								<LoaderIcon className="size-4 animate-spin" />
							) : (
								<PlayIcon className="size-4" />
							)}
							{startMutation.isPending ? "Starting..." : "Start Sandbox"}
						</Button>
					)}
					{isStarted && (
						<Button
							className="w-full justify-start gap-2"
							disabled={stopMutation.isPending}
							onClick={() => stopMutation.mutate()}
							size="sm"
							variant="outline"
						>
							{stopMutation.isPending ? (
								<LoaderIcon className="size-4 animate-spin" />
							) : (
								<SquareIcon className="size-4" />
							)}
							{stopMutation.isPending ? "Stopping..." : "Stop Sandbox"}
						</Button>
					)}
					{isTransitioning && (
						<Button
							className="w-full justify-start gap-2"
							disabled
							size="sm"
							variant="outline"
						>
							<LoaderIcon className="size-4 animate-spin" />
							{status === "creating" ? "Creating..." : "Starting..."}
						</Button>
					)}
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
