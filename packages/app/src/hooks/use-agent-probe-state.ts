import type { AgentProbeResponse } from "@corporation/contracts/sandbox-do";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SpaceActor } from "@/lib/space-client";

export function useAgentProbeState({
	actor,
	spaceSlug,
	enabled,
}: {
	actor: SpaceActor;
	spaceSlug: string;
	enabled: boolean;
}) {
	const queryClient = useQueryClient();
	const probeQueryKey = [
		"agentProbeState",
		spaceSlug,
		actor.connStatus === "connected" ? "connected" : "disconnected",
	];

	const { data, error, isFetching, isLoading } = useQuery<AgentProbeResponse>({
		queryKey: probeQueryKey,
		queryFn: async () => {
			if (!actor.connection) {
				throw new Error("Space connection unavailable");
			}
			return (await actor.connection.getAgentProbeState()) as AgentProbeResponse;
		},
		enabled: enabled && actor.connStatus === "connected" && !!actor.connection,
	});

	return {
		data: data ?? null,
		error:
			error instanceof Error
				? error.message
				: error
					? "Failed to load agent status"
					: null,
		isLoading: isLoading || isFetching,
		refresh: (force = true) => {
			if (force) {
				queryClient.invalidateQueries({
					queryKey: probeQueryKey,
				});
			}
		},
	};
}
