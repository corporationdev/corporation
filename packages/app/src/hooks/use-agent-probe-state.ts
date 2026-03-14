import type {
	AgentProbeAgent,
	AgentProbeResponse,
} from "@corporation/contracts/sandbox-do";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpaceActor } from "@/lib/space-client";

function mergeProbeAgents(
	current: Record<string, AgentProbeAgent>,
	next: AgentProbeAgent[]
) {
	const merged = { ...current };
	for (const agent of next) {
		merged[agent.id] = agent;
	}
	return merged;
}

export function useAgentProbeState({
	actor,
	spaceSlug,
	enabled,
}: {
	actor: SpaceActor;
	spaceSlug: string;
	enabled: boolean;
}) {
	const [probeById, setProbeById] = useState<Record<string, AgentProbeAgent>>(
		{}
	);
	const [checkingById, setCheckingById] = useState<Record<string, boolean>>({});
	const [lastProbedAt, setLastProbedAt] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setProbeById({});
		setCheckingById({});
		setLastProbedAt(null);
		setError(null);
	}, [spaceSlug]);

	const refresh = useCallback(
		async (ids: string[]) => {
			const uniqueIds = [...new Set(ids)];
			if (
				!enabled ||
				uniqueIds.length === 0 ||
				actor.connStatus !== "connected" ||
				!actor.connection
			) {
				return;
			}

			setError(null);
			setCheckingById((current) => ({
				...current,
				...Object.fromEntries(uniqueIds.map((id) => [id, true])),
			}));

			try {
				const result = (await actor.connection.probeAgents(
					uniqueIds
				)) as AgentProbeResponse;
				setProbeById((current) => mergeProbeAgents(current, result.agents));
				setLastProbedAt(result.probedAt);
				return result;
			} catch (nextError) {
				setError(
					nextError instanceof Error
						? nextError.message
						: "Failed to load agent status"
				);
				return null;
			} finally {
				setCheckingById((current) => {
					const next = { ...current };
					for (const id of uniqueIds) {
						delete next[id];
					}
					return next;
				});
			}
		},
		[actor.connection, actor.connStatus, enabled]
	);

	const data = useMemo(
		() =>
			lastProbedAt === null
				? null
				: ({
						probedAt: lastProbedAt,
						agents: Object.values(probeById),
					} satisfies AgentProbeResponse),
		[lastProbedAt, probeById]
	);

	return {
		data,
		error,
		isLoading: Object.keys(checkingById).length > 0,
		isChecking: (id: string) => checkingById[id] === true,
		refresh,
	};
}
