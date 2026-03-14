import { api } from "@corporation/backend/convex/_generated/api";
import acpAgents, {
	type AcpAgentManifestEntry,
} from "@corporation/config/acp-agent-manifest";
import type { AgentProbeAgent } from "@corporation/contracts/sandbox-do";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useAction, useMutation, useQuery } from "convex/react";
import {
	CheckIcon,
	ChevronDownIcon,
	CopyIcon,
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
import { cn } from "@/lib/utils";

function getAgentProbeStatusLabel(
	status: AgentProbeAgent["status"] | undefined,
	isChecking: boolean
) {
	switch (status) {
		case "verified":
			return "Connected";
		case "requires_auth":
			return "Needs auth";
		case "error":
			return "Unavailable";
		case "not_installed":
			return "Not installed";
		default:
			return isChecking ? "Checking..." : "Not connected";
	}
}

function AgentListItem({
	agent,
	isChecking,
	probe,
}: {
	agent: AcpAgentManifestEntry;
	isChecking: boolean;
	probe?: AgentProbeAgent;
}) {
	const [showModels, setShowModels] = useState(false);
	const derivedModels = deriveAgentModels(probe?.configOptions);
	const statusLabel = getAgentProbeStatusLabel(probe?.status, isChecking);
	const models = derivedModels.models;
	const showModelsToggle = models.length > 0;
	const isConnected = probe?.status === "verified";

	return (
		<Collapsible onOpenChange={setShowModels} open={showModels}>
			<div className="group rounded-md transition-colors hover:bg-muted/70">
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
							{isConnected ? (
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
				</div>
				{probe?.error && probe.status === "error" ? (
					<div className="px-2 pb-2 text-muted-foreground text-xs/relaxed">
						{probe.error}
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
	storedAgents,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	storedAgents: Array<{ id: string; configOptions: unknown[] }>;
}) {
	const workspaceState = useQuery(api.userWorkspace.getWorkspaceState);
	const configure = useMutation(api.userWorkspace.configure);
	const saveUserSpaceAction = useAction(api.userWorkspaceActions.save);
	const { mutateAsync: saveUserSpace, isPending: isSaving } =
		useTanstackMutation({
			mutationFn: (args: {
				agents: Array<{ id: string; configOptions: unknown[] }>;
			}) => saveUserSpaceAction(args),
			onSuccess: () => {
				toast.success("Agent configuration saved");
				onOpenChange(false);
			},
			onError: (error) => {
				toast.error(error.message);
			},
		});
	const [configureError, setConfigureError] = useState<string | null>(null);
	const [isVerifyingBeforeSave, setIsVerifyingBeforeSave] = useState(false);
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
		isChecking: isAgentChecking,
		refresh: refreshAgentProbe,
	} = useAgentProbeState({
		actor,
		spaceSlug: agent?.slug ?? "",
		enabled: open && isSandboxReady && isConnected,
	});
	const manifestById = useMemo(
		() =>
			new Map(
				acpAgents.map((manifestAgent) => [manifestAgent.id, manifestAgent])
			),
		[]
	);
	const supportedAgents = useMemo(() => acpAgents, []);
	const supportedAgentIds = useMemo(
		() => new Set(supportedAgents.map((manifestAgent) => manifestAgent.id)),
		[supportedAgents]
	);
	const renderedAgents = supportedAgents;
	const renderedAgentIds = useMemo(
		() => renderedAgents.map((manifestAgent) => manifestAgent.id),
		[renderedAgents]
	);

	const probeByManifestId = useMemo(() => {
		const merged = Object.fromEntries(
			(agentProbeData?.agents ?? []).map((probeAgent) => [
				probeAgent.id,
				probeAgent,
			])
		) as Record<string, AgentProbeAgent>;

		for (const storedAgent of storedAgents) {
			if (merged[storedAgent.id]) {
				continue;
			}

			const manifestAgent = manifestById.get(storedAgent.id);
			merged[storedAgent.id] = {
				authCheckedAt: null,
				configOptions: storedAgent.configOptions,
				error: null,
				id: storedAgent.id,
				name: manifestAgent?.name ?? storedAgent.id,
				status: "verified",
				verifiedAt: null,
			};
		}

		return merged;
	}, [agentProbeData?.agents, manifestById, storedAgents]);
	const handleSave = useCallback(async () => {
		setIsVerifyingBeforeSave(true);
		try {
			const latestProbeResult = await refreshAgentProbe(renderedAgentIds);
			if (!latestProbeResult) {
				toast.error("Failed to verify agent connections");
				return;
			}

			const agentsToSave = latestProbeResult.agents
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

			await saveUserSpace({
				agents: agentsToSave,
			});
		} finally {
			setIsVerifyingBeforeSave(false);
		}
	}, [refreshAgentProbe, renderedAgentIds, saveUserSpace, supportedAgentIds]);
	const hasSupportedConnectedAgents = useMemo(
		() =>
			Object.values(probeByManifestId).some((probe) => {
				const manifestAgent = manifestById.get(probe.id);
				return (
					manifestAgent !== undefined &&
					probe.status === "verified" &&
					Array.isArray(probe.configOptions)
				);
			}),
		[manifestById, probeByManifestId]
	);
	const showReadyState = !!agent && isSandboxReady && isConnected;
	const showErrorState =
		open &&
		workspaceState !== undefined &&
		(agent?.status === "error" || configureError !== null);
	// TODO: migrate to use environments table
	const sandboxId = (agent as Record<string, unknown> | undefined)?.sandboxId as
		| string
		| undefined;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="flex h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-7xl">
				{showReadyState ? (
					<>
						<div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
							<div className="min-w-0 flex-1 overflow-hidden rounded-lg border">
								<PtyTerminal actor={actor} spaceSlug={agent.slug} />
							</div>

							<div className="flex w-72 shrink-0 flex-col rounded-lg border bg-muted/30">
								<div className="px-3 py-2.5">
									<div className="flex items-center justify-between gap-2">
										<div>
											<h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
												Agents
											</h2>
											<div className="mt-1 text-muted-foreground text-xs">
												These agents are preinstalled in every sandbox.
											</div>
										</div>
										<div className="flex items-center gap-1">
											<Button
												disabled={renderedAgentIds.length === 0}
												onClick={() => {
													refreshAgentProbe(renderedAgentIds);
												}}
												size="icon"
												title="Refresh visible agents"
												variant="ghost"
											>
												<RefreshCwIcon
													className={cn(
														"size-3.5",
														isAgentProbeLoading && "animate-spin"
													)}
												/>
											</Button>
											{sandboxId ? (
												<Button
													onClick={() => {
														navigator.clipboard.writeText(sandboxId);
														toast.success("Sandbox ID copied");
													}}
													size="icon"
													title="Copy sandbox ID"
													variant="ghost"
												>
													<CopyIcon className="size-3" />
												</Button>
											) : null}
										</div>
									</div>
								</div>
								<ScrollArea className="min-h-0 flex-1">
									<div className="flex flex-col gap-0.5 px-2 pb-2">
										{agentProbeError ? (
											<div className="px-2 py-1 text-muted-foreground text-xs/relaxed">
												{agentProbeError}
											</div>
										) : null}
										{renderedAgents.map((manifestAgent) => (
											<AgentListItem
												agent={manifestAgent}
												isChecking={isAgentChecking(manifestAgent.id)}
												key={manifestAgent.id}
												probe={probeByManifestId[manifestAgent.id]}
											/>
										))}
									</div>
								</ScrollArea>
							</div>
						</div>
						<div className="relative z-10 flex shrink-0 justify-end gap-2 border-t bg-background pt-4">
							<Button
								onClick={() => onOpenChange(false)}
								size="sm"
								variant="outline"
							>
								Close
							</Button>
							<Button
								disabled={
									isSaving ||
									isVerifyingBeforeSave ||
									!hasSupportedConnectedAgents
								}
								onClick={() => {
									handleSave().catch(() => undefined);
								}}
								size="sm"
							>
								{isSaving || isVerifyingBeforeSave ? (
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
