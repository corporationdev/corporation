import { api } from "@corporation/backend/convex/_generated/api";
import acpAgents from "@corporation/config/acp-agent-manifest";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { DownloadIcon, Loader2Icon, TerminalSquareIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { PtyTerminal } from "@/components/terminal/pty-terminal";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useSpaceActor } from "@/hooks/use-space-actor";

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
	const { actor, isConnected, isSandboxReady } = useSpaceActor(
		workspaceState?.space,
		{ enabled: dialogOpen }
	);

	const sendCommand = useCallback(
		(command: string) => {
			if (!actor.connection) {
				return;
			}
			const bytes = Array.from(new TextEncoder().encode(`${command}\n`));
			actor.connection.input(bytes).catch((e: unknown) => {
				console.error("Failed to send install command", e);
			});
		},
		[actor.connection]
	);

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
				<DialogContent className="sm:max-w-7xl">
					<DialogHeader>
						<DialogTitle>Starting sandbox</DialogTitle>
						<DialogDescription>{statusDescription}</DialogDescription>
					</DialogHeader>

					<div className="flex h-[70vh] gap-4">
						<div className="min-w-0 flex-1 overflow-hidden border">
							{dialogOpen && isSandboxReady && workspaceState.space ? (
								<PtyTerminal
									actor={actor}
									spaceSlug={workspaceState.space.slug}
								/>
							) : (
								<div className="flex h-full flex-col justify-between gap-4 p-4">
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
						</div>

						<div className="w-56 shrink-0 rounded-lg border bg-muted/30">
							<div className="px-3 py-2.5">
								<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
									ACP Agents
								</h3>
							</div>
							<ScrollArea className="h-[calc(70vh-37px)]">
								<div className="flex flex-col gap-0.5 px-2 pb-2">
									{acpAgents.map((agent) => {
										return (
											<div
												className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
												key={agent.id}
											>
												<img
													alt={agent.name}
													className="size-5 shrink-0 brightness-0 invert"
													height={20}
													src={agent.icon}
													width={20}
												/>
												<span className="min-w-0 flex-1 truncate text-[13px]">
													{agent.name}
												</span>
												{agent.installCommand && (
													<button
														className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 disabled:opacity-50 group-hover:opacity-100"
														disabled={!isConnected}
														onClick={() => sendCommand(agent.installCommand)}
														title={`Install ${agent.name}`}
														type="button"
													>
														<DownloadIcon className="size-3.5" />
													</button>
												)}
											</div>
										);
									})}
								</div>
							</ScrollArea>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
