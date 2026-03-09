import { api } from "@corporation/backend/convex/_generated/api";
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
import acpAgents from "@/data/acp-agents.json";
import { useSpaceActor } from "@/hooks/use-space-actor";

export const Route = createFileRoute("/_authenticated/settings/agents")({
	component: AgentsPage,
});

// E2B sandboxes run linux-x86_64
const SANDBOX_PLATFORM = "linux-x86_64" as const;

// Sandbox-specific env overrides for agents that assume root or have
// hardcoded paths incompatible with the E2B sandbox user.
const SANDBOX_ENV_OVERRIDES: Record<string, Record<string, string>> = {};

type AcpAgent = (typeof acpAgents)[number];

/**
 * Build a shell command to install/run an ACP agent in the sandbox.
 * Prefers npx > uvx > binary download.
 * Returns null if no compatible distribution exists.
 */
function getInstallCommand(agent: AcpAgent): string | null {
	const dist = agent.distribution;
	const overrides = SANDBOX_ENV_OVERRIDES[agent.id] ?? {};

	// Prefer npx
	if ("npx" in dist && dist.npx) {
		const npx = dist.npx as {
			package: string;
			args?: string[];
			env?: Record<string, string>;
		};
		const allEnv = { ...npx.env, ...overrides };
		const envEntries = Object.entries(allEnv);
		const envPrefix =
			envEntries.length > 0
				? `${envEntries.map(([k, v]) => `${k}=${v}`).join(" ")} `
				: "";
		const args = npx.args ? ` ${npx.args.join(" ")}` : "";
		return `${envPrefix}npx -y ${npx.package}${args}`;
	}

	// Try uvx
	if ("uvx" in dist && dist.uvx) {
		const uvx = dist.uvx as { package: string; args?: string[] };
		const args = uvx.args ? ` ${uvx.args.join(" ")}` : "";
		return `uvx ${uvx.package}${args}`;
	}

	// Fall back to binary for linux-x86_64
	if ("binary" in dist && dist.binary) {
		const binary = dist.binary as Record<
			string,
			{ archive: string; cmd: string; args?: string[] }
		>;
		const platform = binary[SANDBOX_PLATFORM];
		if (!platform) {
			return null;
		}

		const args = platform.args ? ` ${platform.args.join(" ")}` : "";
		const archiveUrl = platform.archive;
		const isZip = archiveUrl.endsWith(".zip");
		const extractCmd = isZip
			? `curl -fsSL "${archiveUrl}" -o /tmp/agent.zip && unzip -o /tmp/agent.zip -d /tmp/agent && cd /tmp/agent && ${platform.cmd}${args}`
			: `curl -fsSL "${archiveUrl}" | tar xz -C /tmp/agent --strip-components=0 && cd /tmp/agent && ${platform.cmd}${args}`;

		return `mkdir -p /tmp/agent && ${extractCmd}`;
	}

	return null;
}

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
		workspaceState?.space
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
										const command = getInstallCommand(agent);
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
												{command && (
													<button
														className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 disabled:opacity-50 group-hover:opacity-100"
														disabled={!isConnected}
														onClick={() => sendCommand(command)}
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
