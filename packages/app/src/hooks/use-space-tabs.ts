import type { SpaceTab } from "@corporation/server/space";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { softResetActorConnectionOnTransientError } from "@/lib/actor-errors";
import type { SpaceActor } from "@/lib/rivetkit";

function getActorSpaceSlug(actor: SpaceActor): string | undefined {
	const key = actor.opts.key;
	if (typeof key === "string") {
		return key;
	}
	return key[0];
}

type SpaceTabsResult = {
	tabs: SpaceTab[];
	isLoading: boolean;
};

export function useSpaceTabs(actor: SpaceActor): SpaceTabsResult {
	const spaceSlug = getActorSpaceSlug(actor);
	const queryClient = useQueryClient();
	const isConnected = actor.connStatus === "connected" && !!actor.connection;

	const { data, isLoading } = useQuery({
		queryKey: ["space-tabs", spaceSlug],
		queryFn: () => {
			const conn = actor.connection;
			if (!conn) {
				throw new Error("Actor connection is unavailable");
			}
			return conn.listTabs();
		},
		enabled: isConnected,
		retry: (_, error) => {
			const kind = softResetActorConnectionOnTransientError({
				error,
				reasonPrefix: "space-tabs",
				spaceSlug,
			});
			return !!kind;
		},
	});

	actor.useEvent("tabs.changed", (event) => {
		queryClient.setQueryData(["space-tabs", spaceSlug], event as SpaceTab[]);
	});

	return { tabs: data ?? [], isLoading: isLoading && isConnected };
}
