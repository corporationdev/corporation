import type { SessionRow } from "@corporation/contracts/browser-do";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type SpaceActor, useSpaceEvent } from "@/lib/space-client";

function getActorSpaceSlug(actor: SpaceActor): string | undefined {
	const key = actor.opts.key;
	if (typeof key === "string") {
		return key;
	}
	return key[0];
}

type SpaceSessionsResult = {
	sessions: SessionRow[];
	isLoading: boolean;
};

export function useSpaceSessions(actor: SpaceActor): SpaceSessionsResult {
	const spaceSlug = getActorSpaceSlug(actor);
	const queryClient = useQueryClient();
	const isConnected = actor.connStatus === "connected" && !!actor.connection;

	const { data, isLoading } = useQuery<SessionRow[]>({
		queryKey: ["space-sessions", spaceSlug],
		queryFn: async () => {
			const conn = actor.connection;
			if (!conn) {
				throw new Error("Actor connection is unavailable");
			}
			return (await conn.listSessions()) as SessionRow[];
		},
		enabled: isConnected,
		retry: false,
	});

	useSpaceEvent(actor, "sessions.changed", (event) => {
		queryClient.setQueryData(
			["space-sessions", spaceSlug],
			event as SessionRow[]
		);
	});

	return { sessions: data ?? [], isLoading: isLoading && isConnected };
}
