import { useQuery } from "@tanstack/react-query";
import { listSpaceSessions, type SpaceSession } from "@/lib/api-client";

type SpaceSessionsResult = {
	sessions: SpaceSession[];
	isLoading: boolean;
};

export function useSpaceSessions(spaceSlug: string): SpaceSessionsResult {
	const { data, isLoading } = useQuery({
		queryKey: ["space-sessions", spaceSlug],
		queryFn: async () => await listSpaceSessions(spaceSlug),
		enabled: !!spaceSlug,
		retry: false,
	});

	return { sessions: data ?? [], isLoading };
}
