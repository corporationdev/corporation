// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { createFileRoute } from "@tanstack/react-router";

import { ChatLayout } from "@/components/chat-layout";

type SpaceSearchParams = {
	session?: string;
};

export const Route = createFileRoute("/_authenticated/space/$spaceSlug")({
	component: SpaceWithIdRoute,
	validateSearch: (search: Record<string, unknown>): SpaceSearchParams => ({
		session: typeof search.session === "string" ? search.session : undefined,
	}),
});

function SpaceWithIdRoute() {
	return <ChatLayout />;
}
