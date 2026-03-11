import { api } from "@corporation/backend/convex/_generated/api";
import acpAgents, {
	type AcpAgentManifestEntry,
} from "@corporation/config/acp-agent-manifest";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { AgentsConfigureDialog } from "@/components/settings/agents-configure-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings/agents")({
	component: AgentsPage,
});

function AgentCard({
	agent,
	isConfigured,
}: {
	agent: AcpAgentManifestEntry;
	isConfigured: boolean;
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border px-4 py-3">
			<img
				alt={agent.name}
				className="size-6 shrink-0 brightness-0 invert"
				height={24}
				src={agent.icon}
				width={24}
			/>
			<div className="min-w-0 flex-1">
				<div className="font-medium text-sm">{agent.name}</div>
			</div>
			<div
				className={cn(
					"rounded-full px-2.5 py-1 font-medium text-[11px]",
					isConfigured
						? "bg-emerald-500/12 text-emerald-600"
						: "bg-muted text-muted-foreground"
				)}
			>
				{isConfigured ? "Connected" : "Not connected"}
			</div>
		</div>
	);
}

function AgentsPage() {
	const agentConfigs = useQuery(api.agentConfig.list);
	const [dialogOpen, setDialogOpen] = useState(false);
	const connectedConfigByAgentId = useMemo(
		() =>
			new Map((agentConfigs ?? []).map((config) => [config.agentId, config])),
		[agentConfigs]
	);
	const sortedAgents = useMemo(() => {
		const connectedAgents: typeof acpAgents = [];
		const disconnectedAgents: typeof acpAgents = [];

		for (const agent of acpAgents) {
			if (connectedConfigByAgentId.has(agent.id)) {
				connectedAgents.push(agent);
				continue;
			}

			disconnectedAgents.push(agent);
		}

		return [...connectedAgents, ...disconnectedAgents];
	}, [connectedConfigByAgentId]);

	return (
		<>
			<div className="space-y-4 p-6">
				<div className="flex items-center justify-between gap-4">
					<h1 className="font-semibold text-lg">Agents</h1>
					<Button onClick={() => setDialogOpen(true)} size="sm">
						Configure Agents
					</Button>
				</div>

				<div className="space-y-2">
					{agentConfigs === undefined
						? acpAgents.map((agent) => (
								<div
									className="flex items-center gap-3 rounded-lg border px-4 py-3"
									key={agent.id}
								>
									<img
										alt={agent.name}
										className="size-6 shrink-0 brightness-0 invert"
										height={24}
										src={agent.icon}
										width={24}
									/>
									<div className="min-w-0 flex-1">
										<div className="font-medium text-sm">{agent.name}</div>
									</div>
									<Skeleton className="h-6 w-24 rounded-full" />
								</div>
							))
						: sortedAgents.map((agent) => {
								const config = connectedConfigByAgentId.get(agent.id);

								return (
									<AgentCard
										agent={agent}
										isConfigured={!!config}
										key={agent.id}
									/>
								);
							})}
				</div>
			</div>

			<AgentsConfigureDialog onOpenChange={setDialogOpen} open={dialogOpen} />
		</>
	);
}
