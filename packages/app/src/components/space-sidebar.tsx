import { api } from "@corporation/backend/convex/_generated/api";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
	ExternalLinkIcon,
	LoaderIcon,
	PlayIcon,
	SquareIcon,
	TerminalIcon,
} from "lucide-react";
import { nanoid } from "nanoid";
import type { FC } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Sidebar,
	SidebarContent,
	SidebarProvider,
} from "@/components/ui/sidebar";
import { useStartSandbox } from "@/hooks/use-start-sandbox";
import type { SpaceActor } from "@/lib/rivetkit";
import { serializeTab } from "@/lib/tab-routing";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout-store";

export type Space = NonNullable<
	FunctionReturnType<typeof api.spaces.getBySlug>
>;

type SpaceSidebarProps = {
	space?: Space | null;
	actor: SpaceActor;
};

const statusConfig: Record<string, { label: string; className: string }> = {
	creating: { label: "Creating", className: "bg-yellow-500" },
	starting: { label: "Starting", className: "bg-yellow-500" },
	started: { label: "Running", className: "bg-green-500" },
	stopped: { label: "Stopped", className: "bg-muted-foreground" },
	error: { label: "Error", className: "bg-destructive" },
};

export const SpaceSidebar: FC<SpaceSidebarProps> = ({ space, actor }) => {
	const isOpen = useLayoutStore((s) => s.rightSidebarOpen);
	const setIsOpen = useLayoutStore((s) => s.setRightSidebarOpen);

	return (
		<SidebarProvider
			className="w-auto overflow-hidden"
			onOpenChange={setIsOpen}
			open={isOpen}
		>
			<Sidebar collapsible="offcanvas" side="right">
				<SidebarContent className="p-4">
					{space ? <SpaceSidebarContent actor={actor} space={space} /> : null}
				</SidebarContent>
			</Sidebar>
		</SidebarProvider>
	);
};

const SpaceSidebarContent: FC<{
	space: Space;
	actor: SpaceActor;
}> = ({ space, actor }) => {
	const navigate = useNavigate();
	const config = statusConfig[space.status] ?? {
		label: space.status,
		className: "bg-muted-foreground",
	};

	const stopSpace = useMutation(api.spaces.stop);

	const stopMutation = useTanstackMutation({
		mutationFn: () => stopSpace({ id: space._id }),
	});

	const { startSandbox, isStopped, isStarted, isTransitioning } =
		useStartSandbox(space.slug, space.status);

	const handleNewTerminal = () => {
		const terminalId = nanoid();
		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug: space.slug },
			search: { tab: serializeTab({ type: "terminal", id: terminalId }) },
		});
	};

	return (
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
					onClick={startSandbox}
					size="sm"
					variant="outline"
				>
					<PlayIcon className="size-4" />
					Start Sandbox
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
					{space.status === "creating" ? "Creating..." : "Starting..."}
				</Button>
			)}
			<Button
				className="w-full justify-start gap-2"
				disabled={
					actor.connStatus !== "connected" || space.status !== "started"
				}
				onClick={handleNewTerminal}
				size="sm"
				variant="outline"
			>
				<TerminalIcon className="size-4" />
				New Terminal
			</Button>
			{space.sandboxUrl && (
				<a
					className={cn(
						buttonVariants({ variant: "outline", size: "sm" }),
						"w-full justify-start gap-2"
					)}
					href={space.sandboxUrl}
					rel="noopener noreferrer"
					target="_blank"
				>
					<ExternalLinkIcon className="size-4" />
					Open Preview
				</a>
			)}
		</div>
	);
};
