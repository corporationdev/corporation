import { api } from "@corporation/backend/convex/_generated/api";
import { env } from "@corporation/env/web";
import type { FunctionReturnType } from "convex/server";
import { ClipboardIcon, LoaderIcon, PlayIcon, SquareIcon } from "lucide-react";
import { type FC, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	Sidebar,
	SidebarContent,
	SidebarProvider,
} from "@/components/ui/sidebar";
import { useErrorToast } from "@/hooks/use-error-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { useStartSandbox } from "@/hooks/use-start-sandbox";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";
import type { SpaceActor } from "@/lib/rivetkit";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout-store";
import { SandboxCountdown } from "./sandbox-countdown";

export type Space = NonNullable<
	FunctionReturnType<typeof api.spaces.getBySlug>
>;

type SpaceSidebarProps = {
	space?: Space | null;
	actor: SpaceActor;
};

const statusConfig: Record<string, { label: string; className: string }> = {
	creating: { label: "Creating", className: "bg-yellow-500" },
	running: { label: "Running", className: "bg-green-500" },
	paused: { label: "Paused", className: "bg-muted-foreground" },
	killed: { label: "Killed", className: "bg-destructive" },
	error: { label: "Error", className: "bg-destructive" },
};

export const SpaceSidebar: FC<SpaceSidebarProps> = ({ space, actor }) => {
	const isOpen = useLayoutStore((s) => s.rightSidebarOpen);
	const setIsOpen = useLayoutStore((s) => s.setRightSidebarOpen);
	const isMobile = useIsMobile();

	const content = space ? (
		<SpaceSidebarContent actor={actor} space={space} />
	) : null;

	if (isMobile) {
		return (
			<Sheet onOpenChange={setIsOpen} open={isOpen}>
				<SheetContent className="w-[18rem] overflow-auto p-4" side="right">
					<SheetHeader className="sr-only">
						<SheetTitle>Space Sidebar</SheetTitle>
						<SheetDescription>Space controls and actions.</SheetDescription>
					</SheetHeader>
					{content}
				</SheetContent>
			</Sheet>
		);
	}

	return (
		<SidebarProvider
			className="w-auto overflow-hidden"
			onOpenChange={setIsOpen}
			open={isOpen}
		>
			<Sidebar collapsible="offcanvas" side="right">
				<SidebarContent className="p-4">{content}</SidebarContent>
			</Sidebar>
		</SidebarProvider>
	);
};

const SpaceSidebarContent: FC<{
	space: Space;
	actor: SpaceActor;
}> = ({ space, actor }) => {
	const config = statusConfig[space.status] ?? {
		label: space.status,
		className: "bg-muted-foreground",
	};

	const updateMutation = useConvexTanstackMutation(api.spaces.update);
	const { mutate } = updateMutation;
	const clearError = useCallback(
		() => mutate({ id: space._id, error: "" }),
		[mutate, space._id]
	);
	useErrorToast(space.error, clearError);

	const stopMutation = useConvexTanstackMutation(api.spaces.stop);

	const { startSandbox, isStopped, isStarted, isTransitioning } =
		useStartSandbox(space.slug, space.status);

	const handleCopySandboxId = () => {
		if (!space.sandboxId) {
			return;
		}
		navigator.clipboard
			.writeText(space.sandboxId)
			.then(() => {
				toast.success("Sandbox ID copied");
			})
			.catch(() => {
				toast.error("Failed to copy sandbox ID");
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
					onClick={() => stopMutation.mutate({ id: space._id })}
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
					Creating...
				</Button>
			)}
			{env.VITE_STAGE_KIND === "dev" && space.sandboxId && (
				<Button
					className="w-full justify-start gap-2"
					onClick={handleCopySandboxId}
					size="sm"
					variant="outline"
				>
					<ClipboardIcon className="size-4" />
					Copy Sandbox ID
				</Button>
			)}
			{isStarted && (
				<SandboxCountdown actor={actor} expiresAt={space.sandboxExpiresAt} />
			)}
		</div>
	);
};
