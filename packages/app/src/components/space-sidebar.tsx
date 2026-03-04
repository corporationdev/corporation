import { api } from "@corporation/backend/convex/_generated/api";
import { env } from "@corporation/env/web";
import type { SpaceTab } from "@corporation/server/space";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import {
	ClipboardIcon,
	ExternalLinkIcon,
	GitPullRequestIcon,
	GlobeIcon,
	LoaderIcon,
	PlayIcon,
	SquareIcon,
	TerminalIcon,
	UploadIcon,
} from "lucide-react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { apiClient } from "@/lib/api-client";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";
import type { SpaceActor } from "@/lib/rivetkit";
import { serializeTab } from "@/lib/tab-routing";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout-store";
import { SandboxCountdown } from "./sandbox-countdown";
import { SyncCodeButton } from "./sync-code-button";

export type Space = NonNullable<
	FunctionReturnType<typeof api.spaces.getBySlug>
>;

type SpaceSidebarProps = {
	space?: Space | null;
	actor: SpaceActor;
	tabs: SpaceTab[];
};

const statusConfig: Record<string, { label: string; className: string }> = {
	creating: { label: "Creating", className: "bg-yellow-500" },
	running: { label: "Running", className: "bg-green-500" },
	paused: { label: "Paused", className: "bg-muted-foreground" },
	killed: { label: "Killed", className: "bg-destructive" },
	error: { label: "Error", className: "bg-destructive" },
};

export const SpaceSidebar: FC<SpaceSidebarProps> = ({ space, actor, tabs }) => {
	const isOpen = useLayoutStore((s) => s.rightSidebarOpen);
	const setIsOpen = useLayoutStore((s) => s.setRightSidebarOpen);
	const isMobile = useIsMobile();

	const content = space ? (
		<SpaceSidebarContent actor={actor} space={space} tabs={tabs} />
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
	tabs: SpaceTab[];
}> = ({ space, actor, tabs }) => {
	const navigate = useNavigate();
	const config = statusConfig[space.status] ?? {
		label: space.status,
		className: "bg-muted-foreground",
	};

	const [previewPort, setPreviewPort] = useState("3001");

	const updateMutation = useConvexTanstackMutation(api.spaces.update);
	const { mutate } = updateMutation;
	const clearError = useCallback(
		() => mutate({ id: space._id, error: "" }),
		[mutate, space._id]
	);
	useErrorToast(space.error, clearError);

	const stopMutation = useConvexTanstackMutation(api.spaces.stop);

	const previewMutation = useTanstackMutation({
		mutationFn: async (port: number) => {
			if (!space.sandboxId) {
				throw new Error("Space has no sandbox");
			}
			const res = await apiClient.sandbox.preview.$get({
				query: { sandboxId: space.sandboxId, port: String(port) },
			});
			const data = await res.json();
			if ("url" in data) {
				window.open(data.url, "_blank");
			}
		},
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

	const handleOpenPreview = () => {
		const port = Number.parseInt(previewPort, 10);
		if (Number.isNaN(port) || port < 1 || port > 65_535 || !space.sandboxId) {
			return;
		}
		previewMutation.mutate(port);
	};

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
			{isStarted && <SyncCodeButton space={space} />}
			{isStarted && <GitButtons space={space} />}
			{isStarted && (
				<DevServerButtons actor={actor} space={space} tabs={tabs} />
			)}
			<Button
				className="w-full justify-start gap-2"
				disabled={
					actor.connStatus !== "connected" || space.status !== "running"
				}
				onClick={handleNewTerminal}
				size="sm"
				variant="outline"
			>
				<TerminalIcon className="size-4" />
				New Terminal
			</Button>
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
			{space.sandboxId && space.status === "running" && (
				<div className="flex gap-2">
					<Input
						className="w-20"
						max={65_535}
						min={1}
						onChange={(e) => setPreviewPort(e.target.value)}
						placeholder="Port"
						type="number"
						value={previewPort}
					/>
					<Button
						className="flex-1 gap-2"
						disabled={previewMutation.isPending}
						onClick={handleOpenPreview}
						size="sm"
						variant="outline"
					>
						{previewMutation.isPending ? (
							<LoaderIcon className="size-4 animate-spin" />
						) : (
							<GlobeIcon className="size-4" />
						)}
						{previewMutation.isPending ? "Loading..." : "Open Preview"}
					</Button>
				</div>
			)}
			{isStarted && (
				<SandboxCountdown actor={actor} expiresAt={space.sandboxExpiresAt} />
			)}
		</div>
	);
};

const DevServerButtons: FC<{
	space: Space;
	actor: SpaceActor;
	tabs: SpaceTab[];
}> = ({ space, actor, tabs }) => {
	const devServerMutation = useTanstackMutation({
		mutationFn: async (action: "start" | "kill") => {
			if (!actor.connection) {
				throw new Error("Not connected to sandbox");
			}
			if (action === "start") {
				await actor.connection.startDevServer(space.environment.devCommand);
			} else {
				await actor.connection.killDevServer();
			}
		},
	});

	const hasDevCommand = !!space.environment.devCommand;
	const isDevServerRunning = tabs.some(
		(tab) => tab.type === "terminal" && tab.terminalId === "devserver"
	);

	if (!hasDevCommand) {
		return null;
	}

	if (isDevServerRunning) {
		return (
			<Button
				className="w-full justify-start gap-2"
				disabled={
					devServerMutation.isPending || actor.connStatus !== "connected"
				}
				onClick={() => devServerMutation.mutate("kill")}
				size="sm"
				variant="outline"
			>
				{devServerMutation.isPending ? (
					<LoaderIcon className="size-4 animate-spin" />
				) : (
					<SquareIcon className="size-4" />
				)}
				{devServerMutation.isPending ? "Stopping..." : "Kill Dev Server"}
			</Button>
		);
	}

	return (
		<Button
			className="w-full justify-start gap-2"
			disabled={devServerMutation.isPending || actor.connStatus !== "connected"}
			onClick={() => devServerMutation.mutate("start")}
			size="sm"
			variant="outline"
		>
			{devServerMutation.isPending ? (
				<LoaderIcon className="size-4 animate-spin" />
			) : (
				<PlayIcon className="size-4" />
			)}
			{devServerMutation.isPending ? "Starting..." : "Start Dev Server"}
		</Button>
	);
};

const GitButtons: FC<{ space: Space }> = ({ space }) => {
	const createPRMutation = useConvexTanstackMutation(
		api.spaces.createPullRequest,
		{
			onSuccess: () => {
				toast.success("Creating pull request...");
			},
			onError: (error) => {
				toast.error(`Failed to create PR: ${error.message}`);
			},
		}
	);

	const pushCodeMutation = useConvexTanstackMutation(api.spaces.pushCode, {
		onSuccess: () => {
			toast.success("Pushing changes...");
		},
		onError: (error) => {
			toast.error(`Failed to push: ${error.message}`);
		},
	});

	if (!space.prUrl) {
		return (
			<Button
				className="w-full justify-start gap-2"
				disabled={createPRMutation.isPending}
				onClick={() => createPRMutation.mutate({ id: space._id })}
				size="sm"
				variant="outline"
			>
				{createPRMutation.isPending ? (
					<LoaderIcon className="size-4 animate-spin" />
				) : (
					<GitPullRequestIcon className="size-4" />
				)}
				{createPRMutation.isPending ? "Creating..." : "Create Pull Request"}
			</Button>
		);
	}

	return (
		<>
			<Button
				className="w-full justify-start gap-2"
				disabled={pushCodeMutation.isPending}
				onClick={() => pushCodeMutation.mutate({ id: space._id })}
				size="sm"
				variant="outline"
			>
				{pushCodeMutation.isPending ? (
					<LoaderIcon className="size-4 animate-spin" />
				) : (
					<UploadIcon className="size-4" />
				)}
				{pushCodeMutation.isPending ? "Pushing..." : "Push Changes"}
			</Button>
			<a
				className="flex h-9 w-full items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted"
				href={space.prUrl}
				rel="noopener noreferrer"
				target="_blank"
			>
				<ExternalLinkIcon className="size-4" />
				View Pull Request
			</a>
		</>
	);
};
