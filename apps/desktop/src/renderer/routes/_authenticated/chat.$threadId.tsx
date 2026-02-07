// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { createFileRoute } from "@tanstack/react-router";

import { ChatLayout } from "@/components/chat-layout";

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
	component: ChatThreadRoute,
});

function ChatThreadRoute() {
	return <ChatLayout />;
}
