import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SpaceActor } from "@/lib/rivetkit";
import type { SessionRow } from "../../../../apps/server/src/space-do";

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

	const { data, isLoading } = useQuery({
		queryKey: ["space-sessions", spaceSlug],
		queryFn: () => {
			const conn = actor.connection;
			if (!conn) {
				throw new Error("Actor connection is unavailable");
			}
			return Promise.resolve(conn.listSessions()).then((result) =>
				Promise.resolve(result)
			);
		},
		enabled: isConnected,
		retry: false,
	});

	actor.useEvent("sessions.changed", (event) => {
		queryClient.setQueryData(
			["space-sessions", spaceSlug],
			event as SessionRow[]
		);
	});

	return { sessions: data ?? [], isLoading: isLoading && isConnected };
}
