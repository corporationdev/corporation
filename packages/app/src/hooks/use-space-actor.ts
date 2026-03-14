import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getAuthToken } from "@/lib/api-client";
import { useSpaceSocketClient } from "@/lib/space-client";

type SpaceActorSpace =
	| {
			slug: string;
			sandbox?: {
				status?: string;
				externalSandboxId?: string;
			} | null;
	  }
	| null
	| undefined;

export function useSpaceActor(
	spaceSlug: string | undefined,
	space: SpaceActorSpace,
	options?: { enabled?: boolean }
) {
	const isSandboxReady = useMemo(
		() =>
			space?.sandbox?.status === "running" &&
			!!space?.sandbox?.externalSandboxId,
		[space]
	);
	const isEnabled = (options?.enabled ?? true) && !!spaceSlug;
	const { data: authToken } = useQuery({
		queryKey: ["space-auth-token"],
		queryFn: getAuthToken,
		enabled: isEnabled,
		retry: false,
	});
	const actor = useSpaceSocketClient(
		spaceSlug,
		authToken,
		isEnabled && !!authToken
	);
	const isConnected =
		isEnabled &&
		!!authToken &&
		actor.connStatus === "connected" &&
		!!actor.connection;

	return {
		actor,
		isSandboxReady,
		isConnected,
		isBindingSynced: isConnected,
	};
}
