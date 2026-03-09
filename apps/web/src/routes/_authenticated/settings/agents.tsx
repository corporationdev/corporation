import { api } from "@corporation/backend/convex/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Loader2Icon, TerminalSquareIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { TerminalTab } from "@/components/workspace-panel/terminal-tab";
import { useKeepAliveSandbox } from "@/hooks/use-keep-alive-sandbox";
import { useActor } from "@/lib/rivetkit";

export const Route = createFileRoute("/_authenticated/settings/agents")({
	component: AgentsPage,
});

function getStatusLabel(status: string | undefined) {
	switch (status) {
		case "creating":
			return "Starting sandbox";
		case "running":
			return "Sandbox ready";
		case "error":
			return "Sandbox failed";
		default:
			return "Not configured";
	}
}

function getStatusDescription(status: string | undefined) {
	switch (status) {
		case "creating":
			return "Your personal sandbox is booting and the terminal is coming online.";
		case "running":
			return "Your personal sandbox is running.";
		case "error":
			return "The sandbox could not be started.";
		default:
			return "Start a personal sandbox and open its terminal.";
	}
}

function AgentsPage() {
	const workspaceState = useQuery(api.userWorkspace.getWorkspaceState);
	const configure = useMutation(api.userWorkspace.configure);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [configurePending, setConfigurePending] = useState(false);
	const [configureError, setConfigureError] = useState<string | null>(null);

	const startConfigure = useCallback(async () => {
		setConfigurePending(true);
		setConfigureError(null);
		try {
			await configure({});
		} catch (error) {
			setConfigureError(
				error instanceof Error ? error.message : "Failed to configure"
			);
		} finally {
			setConfigurePending(false);
		}
	}, [configure]);

	const spaceStatus = workspaceState?.space?.status;

	const sandboxReady = !!(
		dialogOpen &&
		spaceStatus === "running" &&
		workspaceState?.space?.sandboxId &&
		workspaceState?.space?.agentUrl
	);
	const readySpace = sandboxReady ? (workspaceState?.space ?? null) : null;

	const actor = useActor({
		name: "space",
		key: readySpace?.slug ? [readySpace.slug] : ["agents"],
		createWithInput: readySpace
			? {
					sandboxId: readySpace.sandboxId,
					agentUrl: readySpace.agentUrl,
					workdir: readySpace.workdir,
				}
			: undefined,
		enabled: sandboxReady,
	});
	useKeepAliveSandbox(actor, sandboxReady);

	const statusLabel = getStatusLabel(spaceStatus);
	const statusDescription = getStatusDescription(spaceStatus);
	const statusError = configureError ?? workspaceState?.space?.error ?? null;
	const canRetry = spaceStatus === "error";

	const statusTone = useMemo(() => {
		if (spaceStatus === "error") {
			return "text-destructive";
		}
		if (spaceStatus === "running") {
			return "text-foreground";
		}
		return "text-muted-foreground";
	}, [spaceStatus]);

	if (workspaceState === undefined) {
		return (
			<div className="p-6">
				<h1 className="font-semibold text-lg">Agents</h1>
				<p className="mt-1 mb-4 text-muted-foreground text-sm">
					Start a personal sandbox and open its terminal.
				</p>
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	return (
		<>
			<div className="p-6">
				<h1 className="font-semibold text-lg">Agents</h1>
				<p className="mt-1 mb-4 text-muted-foreground text-sm">
					Start a personal sandbox from your base template or personal snapshot,
					then open its terminal.
				</p>

				<Card>
					<CardHeader>
						<div className="flex items-start justify-between gap-4">
							<div>
								<CardTitle className="flex items-center gap-2">
									<TerminalSquareIcon className="size-4" />
									Personal Sandbox
								</CardTitle>
								<CardDescription>{statusDescription}</CardDescription>
							</div>
							<Button
								onClick={() => {
									setDialogOpen(true);
									startConfigure().catch(() => undefined);
								}}
								size="sm"
							>
								Configure
							</Button>
						</div>
					</CardHeader>
					<CardContent className="space-y-2">
						<div className={`font-medium text-sm ${statusTone}`}>
							{statusLabel}
						</div>
						{statusError && (
							<div className="text-destructive text-xs/relaxed">
								{statusError}
							</div>
						)}
					</CardContent>
				</Card>
			</div>

			<Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
				<DialogContent className="sm:max-w-5xl">
					<DialogHeader>
						<DialogTitle>Starting sandbox</DialogTitle>
						<DialogDescription>{statusDescription}</DialogDescription>
					</DialogHeader>

					{sandboxReady && workspaceState.space ? (
						<div className="h-[70vh] overflow-hidden border">
							<TerminalTab
								actor={actor}
								spaceSlug={workspaceState.space.slug}
							/>
						</div>
					) : (
						<div className="flex min-h-56 flex-col justify-between gap-4 border p-4">
							<div className="flex items-center gap-3">
								<Loader2Icon className="size-4 animate-spin" />
								<div>
									<div className="font-medium text-sm">{statusLabel}</div>
									<div className="text-muted-foreground text-xs/relaxed">
										{statusDescription}
									</div>
								</div>
							</div>

							{statusError && (
								<div className="text-destructive text-xs/relaxed">
									{statusError}
								</div>
							)}

							<div className="flex items-center justify-end gap-2">
								{canRetry && (
									<Button
										disabled={configurePending}
										onClick={() => startConfigure().catch(() => undefined)}
										size="sm"
										variant="outline"
									>
										Retry
									</Button>
								)}
								{configurePending && (
									<span className="text-muted-foreground text-xs">
										Request submitted
									</span>
								)}
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
