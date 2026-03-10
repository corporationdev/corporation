import type { AgentProbeResponse } from "@corporation/contracts/sandbox-do";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthedSpaceActorHandle, type SpaceActor } from "@/lib/rivetkit";

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
			const handle = await getAuthedSpaceActorHandle(spaceSlug);
			return await handle.getAgentProbeState();
		},
		enabled: enabled && actor.connStatus === "connected",
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
