import { createFileRoute } from "@tanstack/react-router";

import { ChatLayout } from "@/components/chat-layout";

export const Route = createFileRoute("/_authenticated/space")({
	component: SpaceRoute,
});

function SpaceRoute() {
	return <ChatLayout />;
}
