import type { AgentProbeResponse } from "@corporation/contracts/sandbox-do";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SpaceActor } from "@/lib/rivetkit";

export function useAgentProbeState({
	actor,
	enabled,
}: {
	actor: SpaceActor;
	enabled: boolean;
}) {
	const queryClient = useQueryClient();
	const probeQueryKey = [
		"agentProbeState",
		actor.connection ? "connected" : "disconnected",
	];

	const { data, error, isLoading } = useQuery<AgentProbeResponse>({
		queryKey: probeQueryKey,
		queryFn: async () => {
			if (!actor.connection) {
				throw new Error("No connection");
			}
			return await actor.connection.getAgentProbeState();
		},
		enabled: enabled && !!actor.connection,
	});

	return {
		data: data ?? null,
		error:
			error instanceof Error
				? error.message
				: error
					? "Failed to load agent status"
					: null,
		isLoading,
		refresh: (force = true) => {
			if (force) {
				queryClient.invalidateQueries({
					queryKey: probeQueryKey,
				});
			}
		},
	};
}
