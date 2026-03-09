import { api } from "@corporation/backend/convex/_generated/api";
import acpAgents, {
	type AcpAgentManifestEntry,
} from "@corporation/config/acp-agent-manifest";
import type { AgentProbeAgent } from "@corporation/contracts/sandbox-do";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
	CheckIcon,
	CopyIcon,
	DownloadIcon,
	Loader2Icon,
	RefreshCwIcon,
	TerminalSquareIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { useAgentProbeState } from "@/hooks/use-agent-probe-state";
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

function getAgentProbeStatusLabel(
	status: AgentProbeAgent["status"] | undefined,
	isChecking: boolean
) {
	switch (status) {
		case "ready":
			return "Configured";
		case "requires_auth":
			return "Needs auth";
		case "error":
			return "Unavailable";
		case "not_installed":
			return "Not installed";
		default:
			return isChecking ? "Checking..." : null;
	}
}

function AgentListItem({
	agent,
	isChecking,
	isConnected,
	isInstalling,
	onInstall,
	probe,
}: {
	agent: AcpAgentManifestEntry;
	isChecking: boolean;
	isConnected: boolean;
	isInstalling: boolean;
	onInstall: (agent: AcpAgentManifestEntry) => void;
	probe?: AgentProbeAgent;
}) {
	const modelsLabel =
		probe && probe.models.length > 0
			? probe.models.map((model) => model.name).join(", ")
			: null;
	const statusLabel = getAgentProbeStatusLabel(probe?.status, isChecking);
	const showInstallButton =
		(typeof agent.nativeInstallCommand === "string" ||
			typeof agent.acpInstallCommand === "string") &&
		(!probe || probe.status === "not_installed");

	return (
		<div className="group flex items-start gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-muted">
			<img
				alt={agent.name}
				className="size-5 shrink-0 brightness-0 invert"
				height={20}
				src={agent.icon}
				width={20}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="min-w-0 truncate text-[13px]">{agent.name}</span>
					{probe?.status === "ready" ? (
						<CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
					) : null}
				</div>
				{statusLabel ? (
					<div className="mt-0.5 text-muted-foreground text-xs">
						{statusLabel}
					</div>
				) : null}
				{modelsLabel ? (
					<div className="mt-1 text-muted-foreground text-xs/relaxed">
						{modelsLabel}
					</div>
				) : null}
				{probe?.error && probe.status === "error" ? (
					<div className="mt-1 text-muted-foreground text-xs/relaxed">
						{probe.error}
					</div>
				) : null}
			</div>
			{showInstallButton ? (
				<button
					className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 disabled:opacity-50 group-hover:opacity-100"
					disabled={!isConnected || isInstalling}
					onClick={() => onInstall(agent)}
					title={`Install ${agent.name}`}
					type="button"
				>
					{isInstalling ? (
						<Loader2Icon className="size-3.5 animate-spin" />
					) : (
						<DownloadIcon className="size-3.5" />
					)}
				</button>
			) : null}
		</div>
	);
}

function AgentsPage() {
	const workspaceState = useQuery(api.userWorkspace.getWorkspaceState);
	const configure = useMutation(api.userWorkspace.configure);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [configurePending, setConfigurePending] = useState(false);
	const [configureError, setConfigureError] = useState<string | null>(null);
	const [installingAgentId, setInstallingAgentId] = useState<string | null>(
		null
	);

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
	const {
		data: agentProbeData,
		error: agentProbeError,
		isLoading: isAgentProbeLoading,
		refresh: refreshAgentProbe,
	} = useAgentProbeState({
		actor,
		enabled: dialogOpen && isSandboxReady && isConnected,
	});

	const installAgent = useCallback(
		async (agent: AcpAgentManifestEntry) => {
			if (!actor.connection) {
				return;
			}

			setInstallingAgentId(agent.id);
			try {
				if (agent.nativeInstallCommand) {
					const bytes = Array.from(
						new TextEncoder().encode(`${agent.nativeInstallCommand}\n`)
					);
					await actor.connection.input(bytes);
				}
				if (agent.acpInstallCommand) {
					await actor.connection.runCommand(agent.acpInstallCommand, true);
				}
				toast.success(`Installing ${agent.name}`);
				window.setTimeout(() => {
					refreshAgentProbe();
				}, 1000);
			} catch (error) {
				console.error("Failed to start agent install", error);
				toast.error(`Failed to install ${agent.name}`);
			} finally {
				setInstallingAgentId(null);
			}
		},
		[actor.connection, refreshAgentProbe]
	);
	const handleCopySandboxId = useCallback(async () => {
		const sandboxId = workspaceState?.space?.sandboxId;
		if (!sandboxId) {
			toast.error("Sandbox ID not available");
			return;
		}
		try {
			await navigator.clipboard.writeText(sandboxId);
			toast.success("Copied sandbox ID");
		} catch {
			toast.error("Failed to copy sandbox ID");
		}
	}, [workspaceState?.space?.sandboxId]);

	const statusLabel = getStatusLabel(spaceStatus);
	const statusDescription = getStatusDescription(spaceStatus);
	const statusError = configureError ?? workspaceState?.space?.error ?? null;
	const canRetry = spaceStatus === "error";
	const sandboxId = workspaceState?.space?.sandboxId;

	const statusTone = useMemo(() => {
		if (spaceStatus === "error") {
			return "text-destructive";
		}
		if (spaceStatus === "running") {
			return "text-foreground";
		}
		return "text-muted-foreground";
	}, [spaceStatus]);
	const probeByManifestId = useMemo(
		() =>
			Object.fromEntries(
				(agentProbeData?.agents ?? []).map((agent) => [agent.id, agent])
			),
		[agentProbeData?.agents]
	);

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

					{sandboxId ? (
						<div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
							<div className="min-w-0">
								<div className="text-muted-foreground text-xs uppercase tracking-wider">
									Sandbox ID
								</div>
								<code className="block truncate font-mono text-xs">
									{sandboxId}
								</code>
							</div>
							<Button onClick={handleCopySandboxId} size="sm" variant="outline">
								<CopyIcon className="size-4" />
								Copy ID
							</Button>
						</div>
					) : null}

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

						<div className="w-72 shrink-0 rounded-lg border bg-muted/30">
							<div className="px-3 py-2.5">
								<div className="flex items-center justify-between gap-2">
									<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
										ACP Agents
									</h3>
									<div className="flex items-center gap-1">
										<Button
											disabled={!(isConnected && isSandboxReady)}
											onClick={() => refreshAgentProbe(true)}
											size="icon"
											variant="ghost"
										>
											<RefreshCwIcon
												className={`size-3 ${
													isAgentProbeLoading ? "animate-spin" : ""
												}`}
											/>
										</Button>
										{isAgentProbeLoading && isSandboxReady ? (
											<Loader2Icon className="size-3 animate-spin text-muted-foreground" />
										) : null}
									</div>
								</div>
							</div>
							<ScrollArea className="h-[calc(70vh-37px)]">
								<div className="flex flex-col gap-0.5 px-2 pb-2">
									{agentProbeError ? (
										<div className="px-2 py-1 text-muted-foreground text-xs/relaxed">
											{agentProbeError}
										</div>
									) : null}
									{acpAgents.map((agent) => {
										return (
											<AgentListItem
												agent={agent}
												isChecking={isAgentProbeLoading && isSandboxReady}
												isConnected={isConnected}
												isInstalling={installingAgentId === agent.id}
												key={agent.id}
												onInstall={installAgent}
												probe={probeByManifestId[agent.id]}
											/>
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
