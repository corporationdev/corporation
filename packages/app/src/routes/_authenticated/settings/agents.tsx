import { createFileRoute } from "@tanstack/react-router";
import { api } from "@tendril/backend/convex/_generated/api";
import acpAgents, {
	type AcpAgentManifestEntry,
} from "@tendril/config/acp-agent-manifest";
import { useQuery } from "convex/react";
import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings/agents")({
	component: AgentsPage,
});

function AgentCard({
	agent,
	isConnected,
}: {
	agent: AcpAgentManifestEntry;
	isConnected: boolean;
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
					isConnected
						? "bg-emerald-500/12 text-emerald-600"
						: "bg-muted text-muted-foreground"
				)}
			>
				{isConnected ? "Connected" : "Not connected"}
			</div>
		</div>
	);
}

function AgentsPage() {
	const agentCredentials = useQuery(api.agentCredentials.list);
	const connectedCredentialsByAgentId = useMemo(
		() =>
			new Map(
				(agentCredentials ?? []).map((credential) => [
					credential.agentId,
					credential,
				])
			),
		[agentCredentials]
	);
	const connectedAgentIds = useMemo(
		() => new Set(connectedCredentialsByAgentId.keys()),
		[connectedCredentialsByAgentId]
	);

	const supportedAgents = useMemo(() => acpAgents, []);
	const sortedAgents = useMemo(() => {
		const connectedAgents: typeof acpAgents = [];
		const disconnectedAgents: typeof acpAgents = [];

		for (const agent of supportedAgents) {
			if (connectedAgentIds.has(agent.id)) {
				connectedAgents.push(agent);
				continue;
			}

			disconnectedAgents.push(agent);
		}

		return [...connectedAgents, ...disconnectedAgents];
	}, [supportedAgents, connectedAgentIds]);

	return (
		<div className="space-y-4 p-6">
			<div className="flex items-center justify-between gap-4">
				<h1 className="font-semibold text-lg">Agents</h1>
			</div>

			<div className="space-y-2">
				{agentCredentials === undefined
					? supportedAgents.map((agent) => (
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
					: sortedAgents.map((agent) => (
							<AgentCard
								agent={agent}
								isConnected={connectedAgentIds.has(agent.id)}
								key={agent.id}
							/>
						))}
			</div>
		</div>
	);
}
