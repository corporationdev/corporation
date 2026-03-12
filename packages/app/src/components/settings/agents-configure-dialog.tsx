import { api } from "@corporation/backend/convex/_generated/api";
import acpAgents, {
	type AcpAgentManifestEntry,
	supportsAgentCredentials,
} from "@corporation/config/acp-agent-manifest";
import type { AgentProbeAgent } from "@corporation/contracts/sandbox-do";
import { useMutation, useQuery } from "convex/react";
import {
	CheckIcon,
	ChevronDownIcon,
	CopyIcon,
	DownloadIcon,
	Loader2Icon,
	RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PtyTerminal } from "@/components/terminal/pty-terminal";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAgentProbeState } from "@/hooks/use-agent-probe-state";
import { useSpaceActor } from "@/hooks/use-space-actor";
import { deriveAgentModels } from "@/lib/agent-config-options";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";
import { cn } from "@/lib/utils";

function getAgentProbeStatusLabel(
	agent: AcpAgentManifestEntry,
	status: AgentProbeAgent["status"] | undefined,
	isChecking: boolean
) {
	if (!supportsAgentCredentials(agent)) {
		return "Not supported yet";
	}

	switch (status) {
		case "verified":
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
	const [showModels, setShowModels] = useState(false);
	const derivedModels = deriveAgentModels(probe?.configOptions);
	const isSupported = supportsAgentCredentials(agent);
	const statusLabel = getAgentProbeStatusLabel(agent, probe?.status, isChecking);
	const showInstallButton =
		isSupported &&
		(typeof agent.nativeInstallCommand === "string" ||
			typeof agent.acpInstallCommand === "string") &&
		(!probe || probe.status === "not_installed");
	const models = derivedModels.models;
	const showModelsToggle = models.length > 0;

	return (
		<Collapsible onOpenChange={setShowModels} open={showModels}>
			<div
				className={cn(
					"group rounded-md transition-colors",
					isSupported ? "hover:bg-muted/70" : "opacity-60"
				)}
			>
				<div className="flex items-center gap-2 px-2 py-2">
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
							{probe?.status === "verified" ? (
								<CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
							) : null}
						</div>
						{statusLabel ? (
							<div className="mt-0.5 text-muted-foreground text-xs">
								{statusLabel}
							</div>
						) : null}
					</div>
					{showModelsToggle ? (
						<CollapsibleTrigger
							className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							type="button"
						>
							<span>{models.length} models</span>
							<ChevronDownIcon
								className={cn(
									"size-3 transition-transform",
									showModels ? "rotate-180" : "rotate-0"
								)}
							/>
						</CollapsibleTrigger>
					) : null}
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
				{probe?.error && probe.status === "error" ? (
					<div className="px-2 pb-2 text-muted-foreground text-xs/relaxed">
						{probe.error}
					</div>
				) : !isSupported ? (
					<div className="px-2 pb-2 text-muted-foreground text-xs/relaxed">
						{agent.unsupportedReason ?? "Credential sync is not supported yet."}
					</div>
				) : null}
				{showModelsToggle ? (
					<CollapsibleContent>
						<div className="px-2 pb-2">
							<div className="max-h-28 overflow-y-auto rounded-md border bg-background/60 p-1.5">
								<div className="flex flex-wrap gap-1">
									{models.map((model) => (
										<span
											className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
											key={model.id}
										>
											{model.name}
										</span>
									))}
								</div>
							</div>
						</div>
					</CollapsibleContent>
				) : null}
			</div>
		</Collapsible>
	);
}

export function AgentsConfigureDialog({
	onOpenChange,
	open,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const workspaceState = useQuery(api.userWorkspace.getWorkspaceState);
	const configure = useMutation(api.userWorkspace.configure);
	const { mutate: saveUserSpace, isPending: isSaving } =
		useConvexTanstackMutation(api.userWorkspace.save, {
			onSuccess: () => {
				toast.success("Agent configuration saved");
				onOpenChange(false);
			},
			onError: (error) => {
				toast.error(error.message);
			},
		});
	const [configureError, setConfigureError] = useState<string | null>(null);
	const [installingAgentId, setInstallingAgentId] = useState<string | null>(
		null
	);
	const hasRequestedConfigureRef = useRef(false);

	const startConfigure = useCallback(async () => {
		setConfigureError(null);
		try {
			await configure({});
		} catch (error) {
			setConfigureError(
				error instanceof Error ? error.message : "Failed to configure agents"
			);
		}
	}, [configure]);

	useEffect(() => {
		if (!open) {
			hasRequestedConfigureRef.current = false;
			setConfigureError(null);
			setInstallingAgentId(null);
			return;
		}

		if (workspaceState === undefined || hasRequestedConfigureRef.current) {
			return;
		}

		if (workspaceState.space?.status === "running") {
			return;
		}

		hasRequestedConfigureRef.current = true;
		startConfigure().catch(() => undefined);
	}, [open, startConfigure, workspaceState]);

	const agent = workspaceState?.space;
	const { actor, isConnected, isSandboxReady } = useSpaceActor(
		agent?.slug,
		workspaceState?.space,
		{ enabled: open }
	);
	const {
		data: agentProbeData,
		error: agentProbeError,
		isLoading: isAgentProbeLoading,
		refresh: refreshAgentProbe,
	} = useAgentProbeState({
		actor,
		spaceSlug: agent?.slug ?? "",
		enabled: open && isSandboxReady && isConnected,
	});
	const manifestById = useMemo(
		() =>
			new Map(acpAgents.map((manifestAgent) => [manifestAgent.id, manifestAgent])),
		[]
	);
	const supportedAgentIds = useMemo(
		() =>
			new Set(
				acpAgents
					.filter((manifestAgent) => supportsAgentCredentials(manifestAgent))
					.map((manifestAgent) => manifestAgent.id)
			),
		[]
	);

	const installAgent = useCallback(
		async (manifestAgent: AcpAgentManifestEntry) => {
			if (!actor.connection || !supportsAgentCredentials(manifestAgent)) {
				return;
			}

			setInstallingAgentId(manifestAgent.id);
			try {
				if (manifestAgent.nativeInstallCommand) {
					const terminalInstallCommand = [
						'export PATH="$HOME/.local/bin:$PATH"',
						manifestAgent.nativeInstallCommand,
						"hash -r",
					].join("\n");
					await actor.connection.runCommand(terminalInstallCommand, false);
				}
				if (manifestAgent.acpInstallCommand) {
					await actor.connection.runCommand(
						manifestAgent.acpInstallCommand,
						true
					);
				}
				window.setTimeout(() => {
					refreshAgentProbe();
				}, 1000);
			} catch (error) {
				console.error("Failed to start agent install", error);
				toast.error(`Failed to install ${manifestAgent.name}`);
			} finally {
				setInstallingAgentId(null);
			}
		},
		[actor.connection, refreshAgentProbe]
	);

	const handleSave = useCallback(() => {
		const agentsToSave = (agentProbeData?.agents ?? [])
			.filter(
				(probe): probe is typeof probe & { configOptions: unknown[] } =>
					probe.status === "verified" &&
					Array.isArray(probe.configOptions) &&
					supportedAgentIds.has(probe.id)
			)
			.map((probe) => ({
				id: probe.id,
				configOptions: probe.configOptions,
			}));

		saveUserSpace({
			agents: agentsToSave,
		});
	}, [agentProbeData?.agents, saveUserSpace, supportedAgentIds]);

	const probeByManifestId = useMemo(
		() =>
			Object.fromEntries(
				(agentProbeData?.agents ?? []).map((probeAgent) => [
					probeAgent.id,
					probeAgent,
				])
			),
		[agentProbeData?.agents]
	);
	const hasSupportedVerifiedAgents = useMemo(
		() =>
			(agentProbeData?.agents ?? []).some((probe) => {
				const manifestAgent = manifestById.get(probe.id);
				return (
					manifestAgent !== undefined &&
					supportsAgentCredentials(manifestAgent) &&
					probe.status === "verified" &&
					Array.isArray(probe.configOptions)
				);
			}),
		[agentProbeData?.agents, manifestById]
	);
	const showReadyState = !!agent && isSandboxReady && isConnected;
	const showErrorState =
		open &&
		workspaceState !== undefined &&
		(agent?.status === "error" || configureError !== null);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-7xl">
				{showReadyState ? (
					<>
						<div className="flex h-[70vh] gap-4">
							<div className="min-w-0 flex-1 overflow-hidden rounded-lg border">
								<PtyTerminal actor={actor} spaceSlug={agent.slug} />
							</div>

							<div className="w-72 shrink-0 rounded-lg border bg-muted/30">
								<div className="px-3 py-2.5">
									<div className="flex items-center justify-between gap-2">
										<div>
											<h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
												Agents
											</h2>
											<div className="mt-1 text-muted-foreground text-xs">
												Only explicitly supported agents can be saved.
											</div>
										</div>
										<div className="flex items-center gap-1">
											{agent.sandboxId ? (
												<Button
													onClick={() => {
														navigator.clipboard.writeText(agent.sandboxId!);
														toast.success("Sandbox ID copied");
													}}
													size="icon"
													title="Copy sandbox ID"
													variant="ghost"
												>
													<CopyIcon className="size-3" />
												</Button>
											) : null}
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
										{acpAgents.map((manifestAgent) => (
											<AgentListItem
												agent={manifestAgent}
												isChecking={isAgentProbeLoading}
												isConnected={isConnected}
												isInstalling={installingAgentId === manifestAgent.id}
												key={manifestAgent.id}
												onInstall={installAgent}
												probe={probeByManifestId[manifestAgent.id]}
											/>
										))}
									</div>
								</ScrollArea>
							</div>
						</div>
						<div className="flex justify-end gap-2">
							<Button
								onClick={() => onOpenChange(false)}
								size="sm"
								variant="outline"
							>
								Close
							</Button>
							<Button
								disabled={isSaving || !hasSupportedVerifiedAgents}
								onClick={handleSave}
								size="sm"
							>
								{isSaving ? (
									<>
										<Loader2Icon className="size-4 animate-spin" />
										Saving
									</>
								) : (
									"Save"
								)}
							</Button>
						</div>
					</>
				) : showErrorState ? (
					<div className="flex min-h-[420px] flex-col items-center justify-center gap-4 text-center">
						<div className="space-y-1">
							<div className="font-medium text-sm">Unable to connect</div>
							<div className="max-w-sm text-muted-foreground text-xs/relaxed">
								{configureError ??
									agent?.error ??
									"Failed to open the agent terminal."}
							</div>
						</div>
						<div className="flex items-center gap-2">
							<Button
								onClick={() => startConfigure().catch(() => undefined)}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
							<Button onClick={() => onOpenChange(false)} size="sm">
								Close
							</Button>
						</div>
					</div>
				) : (
					<div className="flex min-h-[420px] flex-col items-center justify-center gap-3">
						<Loader2Icon className="size-5 animate-spin" />
						<div className="font-medium text-sm">Connecting</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
