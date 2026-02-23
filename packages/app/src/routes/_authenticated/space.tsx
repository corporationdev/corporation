import { createFileRoute } from "@tanstack/react-router";

import { SpaceLayout } from "@/components/space-layout";

export const Route = createFileRoute("/_authenticated/space")({
	component: SpaceRoute,
});

function SpaceRoute() {
	return <SpaceLayout />;
}
