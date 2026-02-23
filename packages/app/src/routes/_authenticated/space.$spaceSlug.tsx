// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { createFileRoute } from "@tanstack/react-router";

import { SpaceLayout } from "@/components/space-layout";

type SpaceSearchParams = {
	tab?: string;
};

export const Route = createFileRoute("/_authenticated/space/$spaceSlug")({
	component: SpaceWithIdRoute,
	validateSearch: (search: Record<string, unknown>): SpaceSearchParams => ({
		tab: typeof search.tab === "string" ? search.tab : undefined,
	}),
});

function SpaceWithIdRoute() {
	return <SpaceLayout />;
}
